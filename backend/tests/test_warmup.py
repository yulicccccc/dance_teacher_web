"""Tests for the librosa/numba JIT warmup that fixes the daemon-thread deadlock.

The bug: librosa's ``onset_strength`` / ``beat_track`` / ``onset_detect``
trigger a numba JIT on their *first* call; that first compile deadlocks inside
uvicorn's daemon thread, so the background pipeline hangs at ``beat_detecting``
forever. The fix is to pre-compile those functions on the worker's *main*
thread (app/main.py lifespan -> warmup()), after which every daemon-thread
call reuses the cached compiled Dispatchers.

These tests are guarded by librosa availability (no 3.13 wheel in this sandbox)
and will be SKIPPED here; run on Python 3.10/3.11 for real validation.
"""
from __future__ import annotations

import threading
import wave

import numpy as np
import pytest

from app.services import beat_detector as bd


def _has_librosa() -> bool:
    return __import__("importlib").util.find_spec("librosa") is not None


def _make_click_wav(path: str, bpm: float = 120.0, duration: float = 8.0, sr: int = 16000) -> None:
    """Render a short mono 16-bit click track (mirrors test_beat_detector helper)."""
    interval = 60.0 / bpm
    n = int(sr * duration)
    t = np.arange(n) / sr
    clicks = np.zeros(n, dtype=np.float32)
    for k in range(int(duration / interval) + 2):
        idx = int(k * interval * sr)
        if idx < n:
            clicks[idx] = 1.0
    tone = 0.05 * np.sin(2.0 * np.pi * 220.0 * t)
    signal = (np.clip(clicks * 0.8 + tone, -1.0, 1.0) * 32767).astype("<i2")
    with wave.open(path, "wb") as wf:
        wf.setnchannels(1)
        wf.setsampwidth(2)
        wf.setframerate(sr)
        wf.writeframes(signal.tobytes())


@pytest.mark.skipif(not _has_librosa(), reason="librosa not installed (no 3.13 wheel) — run on Python 3.10/3.11")
def test_warmup_is_idempotent_and_does_not_raise():
    # First call triggers the (potentially slow) JIT compile; the second must be
    # a cheap no-op. Neither should raise in this environment.
    bd.warmup()
    bd.warmup()  # repeated call must be safe and not re-compile


@pytest.mark.skipif(not _has_librosa(), reason="librosa not installed (no 3.13 wheel) — run on Python 3.10/3.11")
def test_warmup_lets_daemon_thread_detect_without_deadlock(tmp_path):
    """Reproduce the production scenario: warmup on the main thread, then run
    ``detect()`` in a uvicorn-style daemon thread.

    Before the fix this deadlocked forever (no error, no return). With ``warmup``
    the compiled Dispatchers are cached and the daemon thread must finish.
    """
    # Main thread: pre-compile (mirrors app/main.py lifespan startup event).
    bd.warmup()

    wav = tmp_path / "click_120.wav"
    _make_click_wav(str(wav), bpm=120.0, duration=8.0)

    result: dict = {}

    def _run() -> None:
        try:
            result["value"] = bd.detect(str(wav))
        except Exception as exc:  # noqa: BLE001
            result["error"] = exc

    th = threading.Thread(target=_run, daemon=True)
    th.start()
    th.join(timeout=30)

    assert not th.is_alive(), "detect() deadlocked in the daemon thread (warmup failed to cache JIT)"
    assert "error" not in result, f"detect raised in daemon thread: {result.get('error')}"

    bpm, confidence, beat_times, duration = result["value"]
    assert 100.0 <= bpm <= 140.0, f"unexpected bpm {bpm}"
    assert len(beat_times) >= 10, f"too few beats detected: {len(beat_times)}"
    assert 7.0 <= duration <= 9.0
