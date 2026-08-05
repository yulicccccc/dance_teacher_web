"""In-memory task registry with JSON persistence and an async pipeline runner.

A single `task_manager` singleton is shared by the routers. Each analysis runs
in a daemon thread so `POST /upload` returns immediately and the frontend polls
`GET /analysis/{taskId}`. Tasks are also flushed to `backend/data/tasks/*.json`
so progress survives a backend restart.
"""
from __future__ import annotations

import inspect
import json
import os
import threading
import uuid
import wave
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass, field
from typing import List, Optional

from ..core.config import LOW_CONFIDENCE_THRESHOLD, TASKS_DIR, ensure_dirs
from ..models.task import AnalysisTask
from ..schemas.analysis import Segment
from . import segmenter
from .audio_extractor import extract
from .beat_detector import detect


class TaskManager:
    def __init__(self, tasks_dir: str = TASKS_DIR) -> None:
        ensure_dirs()
        self._tasks_dir = tasks_dir
        self._tasks: dict[str, AnalysisTask] = {}
        self._lock = threading.Lock()
        self._load_all()

    # ---- persistence -------------------------------------------------
    def _path(self, task_id: str) -> str:
        return os.path.join(self._tasks_dir, f"{task_id}.json")

    def _save(self, task: AnalysisTask) -> None:
        with open(self._path(task.task_id), "w", encoding="utf-8") as fh:
            json.dump(task.to_dict(), fh, ensure_ascii=False, indent=2)

    def _load_all(self) -> None:
        if not os.path.isdir(self._tasks_dir):
            return
        for name in os.listdir(self._tasks_dir):
            if name.endswith(".json"):
                try:
                    with open(os.path.join(self._tasks_dir, name), "r", encoding="utf-8") as fh:
                        self._tasks[name[:-5]] = AnalysisTask.from_dict(json.load(fh))
                except Exception:
                    continue

    # ---- lifecycle ---------------------------------------------------
    def create_task(
        self,
        video_name: str,
        video_path: Optional[str] = None,
        source_url: Optional[str] = None,
    ) -> str:
        task_id = str(uuid.uuid4())
        task = AnalysisTask(
            task_id=task_id,
            status="queued",
            video_name=video_name,
            video_path=video_path,
            source_url=source_url,
            created_at=_now(),
        )
        with self._lock:
            self._tasks[task_id] = task
            self._save(task)
        threading.Thread(target=self._run_pipeline, args=(task_id,), daemon=True).start()
        return task_id

    def get_status(self, task_id: str) -> Optional[AnalysisTask]:
        return self._tasks.get(task_id)

    def retry(self, task_id: str) -> bool:
        task = self._tasks.get(task_id)
        if task is None:
            return False
        with self._lock:
            task.status = "queued"
            task.progress = 0
            task.error = None
            task.beat_times = []
            task.segments = []
            task.beat_low_confidence = False
            self._save(task)
        threading.Thread(target=self._run_pipeline, args=(task_id,), daemon=True).start()
        return True

    def recompute(
        self,
        task_id: str,
        mode: str,
        first_beat_time: Optional[float] = None,
        bpm: Optional[float] = None,
    ) -> Optional[AnalysisTask]:
        """Re-derive segments using one of the fallback strategies.

        Modes:
          - ``fixed120``: hard-coded 120 BPM grid (legacy fallback).
          - ``fixedBpm``: user-typed BPM (40-300). Builds a regular grid at that
            exact tempo and treats it as fully confident.
          - ``manual_first_beat``: re-grid anchored on a user-supplied first beat.
          - ``auto``: re-run beat detection on the stored audio.
        """
        task = self._tasks.get(task_id)
        if task is None:
            return None

        if mode == "fixed120":
            beats = segmenter.generate_fixed_beats(task.duration, 120.0)
            task.bpm = 120.0
            task.confidence = 1.0
        elif mode == "fixedBpm":
            # The router already returns 422 for an out-of-range value; this is a
            # defensive second check so the service can never build a degenerate
            # (or None) grid if called directly.
            if bpm is None or bpm < 40 or bpm > 300:
                raise ValueError("BPM 需在 40–300 之间")
            beats = segmenter.generate_fixed_beats(task.duration, float(bpm))
            task.bpm = float(bpm)
            task.confidence = 1.0
        elif mode == "manual_first_beat":
            if first_beat_time is None:
                raise ValueError("manual_first_beat 模式需要提供 firstBeatTime")
            beats = segmenter.generate_from_first_beat(
                first_beat_time, task.bpm or 120.0, task.duration
            )
        elif mode == "auto":
            if not task.wav_path or not os.path.exists(task.wav_path):
                raise ValueError("没有可重新分析的音频，请使用『重新分析』")
            bpm, confidence, beat_times, _ = detect(task.wav_path)
            task.bpm = bpm
            task.confidence = confidence
            beats = beat_times
        else:
            raise ValueError(f"未知的重算模式：{mode}")

        task.beat_times = beats
        task.segments = segmenter.aggregate(beats, task.duration)
        task.beat_low_confidence = False
        task.status = "done"
        task.progress = 100
        task.error = None
        with self._lock:
            self._save(task)
        return task

    # ---- pipeline ----------------------------------------------------
    def _update(self, task: AnalysisTask, status: str, progress: int) -> None:
        task.status = status
        task.progress = progress
        with self._lock:
            self._save(task)

    def _set_progress(self, task: AnalysisTask, progress: int) -> None:
        """Update only the progress field (status untouched), thread-safe."""
        task.progress = progress
        with self._lock:
            self._save(task)

    def _run_pipeline(self, task_id: str) -> None:
        task = self._tasks.get(task_id)
        if task is None:
            return
        try:
            self._update(task, "extracting", 10)
            wav_path = extract(task.video_path)
            task.wav_path = wav_path

            self._update(task, "beat_detecting", 40)
            # Timeout-guarded beat detection. The previous implementation called
            # detect() directly inside this daemon thread; when librosa's
            # per-window tempo estimate hit a numba/llvmlite JIT deadlock under
            # uvicorn --reload, the call hung FOREVER (no error, no return) and
            # the task was stuck at "beat_detecting". We now run detect() in a
            # short-lived worker thread with a hard timeout so any future
            # librosa stall surfaces as a clean task failure instead of a
            # permanent hang.
            timeout = max(60.0, _wav_duration(wav_path) * 3.0)
            callback = lambda p: self._set_progress(task, p)  # noqa: E731
            try:
                with ThreadPoolExecutor(max_workers=1) as ex:
                    sig_params = inspect.signature(detect).parameters
                    if "progress_callback" in sig_params:
                        future = ex.submit(detect, wav_path, progress_callback=callback)
                    else:
                        future = ex.submit(detect, wav_path)
                    bpm, confidence, beat_times, duration = future.result(timeout=timeout)
            except TimeoutError:
                raise RuntimeError(
                    f"节拍检测超时（{timeout:.0f}s）已被强制终止，以避免后台线程永久挂起；"
                    f"请检查音频或 librosa/numba 环境。"
                )
            task.bpm = bpm
            task.confidence = confidence
            task.beat_times = beat_times
            task.duration = duration

            self._update(task, "segmenting", 80)
            segments = segmenter.aggregate(beat_times, duration)
            task.segments = segments
            task.beat_low_confidence = confidence < LOW_CONFIDENCE_THRESHOLD

            task.status = "done"
            task.progress = 100
            with self._lock:
                self._save(task)
        except Exception as exc:  # noqa: BLE001 - surface as task failure
            task.status = "failed"
            task.error = str(exc)
            task.progress = 0
            with self._lock:
                self._save(task)


def _wav_duration(wav_path: str) -> float:
    """Return audio duration in seconds from a WAV header (lightweight, no ffmpeg).

    The extractor always emits 16-bit PCM mono WAV, so the stdlib `wave` module
    is sufficient and avoids pulling in soundfile/librosa just to size a timeout.
    Returns 0.0 on any failure so callers fall back to the 60s floor.
    """
    try:
        with wave.open(wav_path, "rb") as wf:
            frame_rate = wf.getframerate()
            n_frames = wf.getnframes()
            if frame_rate > 0:
                return float(n_frames) / float(frame_rate)
    except Exception:
        pass
    return 0.0


def _now() -> str:
    from datetime import datetime, timezone

    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


# Module-level singleton shared by all routers.
task_manager = TaskManager()
