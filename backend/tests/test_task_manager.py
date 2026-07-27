"""Tests for app.services.task_manager — state machine, retry, recompute."""
from __future__ import annotations

import time

import pytest

from app.services import task_manager as tm_mod
from app.services.task_manager import TaskManager

# A clean 8s / 16-beat grid (120 BPM) used by the pipeline mock.
FAKE_BEATS = [round(i * 0.5, 4) for i in range(16)]
FAKE_DURATION = 8.0


def _wait_for(tm: TaskManager, task_id: str, states, timeout: float = 3.0) -> str:
    deadline = time.time() + timeout
    while time.time() < deadline:
        st = tm.get_status(task_id)
        if st is None:
            return "missing"
        if st.status in states:
            return st.status
        time.sleep(0.02)
    return tm.get_status(task_id).status


def test_pipeline_runs_to_done(tmp_path, monkeypatch):
    """queued -> extracting -> beat_detecting -> segmenting -> done."""
    monkeypatch.setattr(tm_mod, "extract", lambda vp: "/tmp/fake.wav")
    monkeypatch.setattr(
        tm_mod, "detect", lambda wp: (120.0, 0.9, list(FAKE_BEATS), FAKE_DURATION)
    )
    tm = TaskManager(tasks_dir=str(tmp_path))
    tid = tm.create_task(video_name="dance.mp4")

    final = _wait_for(tm, tid, ("done", "failed"))
    assert final == "done"
    task = tm.get_status(tid)
    assert task.progress == 100
    assert task.bpm == 120.0
    assert len(task.segments) == 2
    assert task.segments[0].index == 1


def test_pipeline_failure_sets_failed(tmp_path, monkeypatch):
    monkeypatch.setattr(tm_mod, "extract", lambda vp: (_ for _ in ()).throw(RuntimeError("ffmpeg boom")))
    tm = TaskManager(tasks_dir=str(tmp_path))
    tid = tm.create_task(video_name="bad.mp4")
    final = _wait_for(tm, tid, ("done", "failed"))
    assert final == "failed"
    assert tm.get_status(tid).error is not None


def test_retry_resets_state(tmp_path, monkeypatch):
    """retry() returns True and resets status/progress/error synchronously."""
    monkeypatch.setattr(tm_mod.TaskManager, "_run_pipeline", lambda self, tid: None)
    tm = TaskManager(tasks_dir=str(tmp_path))
    tid = tm.create_task(video_name="a.mp4")
    t = tm.get_status(tid)
    t.status = "failed"
    t.error = "boom"
    t.progress = 0

    assert tm.retry(tid) is True
    reset = tm.get_status(tid)
    assert reset.status == "queued"
    assert reset.progress == 0
    assert reset.error is None


def test_retry_unknown_task_returns_false(tmp_path):
    tm = TaskManager(tasks_dir=str(tmp_path))
    assert tm.retry("does-not-exist") is False


def test_get_status_unknown_returns_none(tmp_path):
    tm = TaskManager(tasks_dir=str(tmp_path))
    assert tm.get_status("nope") is None


def test_recompute_fixed120(tmp_path, monkeypatch):
    # No-op the background pipeline so create_task can't race recompute.
    monkeypatch.setattr(TaskManager, "_run_pipeline", lambda self, tid: None)
    tm = TaskManager(tasks_dir=str(tmp_path))
    tid = tm.create_task(video_name="x.mp4")
    tm.get_status(tid).duration = FAKE_DURATION

    res = tm.recompute(tid, "fixed120")
    assert res.status == "done"
    assert res.progress == 100
    assert res.bpm == 120.0
    assert res.confidence == 1.0
    assert len(res.segments) == 2
    for s in res.segments:
        assert len(s.beats) == 8
        assert s.type == "dance"
    assert res.segments[0].index == 1
    assert res.segments[0].startTime == 0.0


def test_recompute_manual_first_beat(tmp_path, monkeypatch):
    monkeypatch.setattr(TaskManager, "_run_pipeline", lambda self, tid: None)
    tm = TaskManager(tasks_dir=str(tmp_path))
    tid = tm.create_task(video_name="x.mp4")
    t = tm.get_status(tid)
    t.duration = FAKE_DURATION
    t.bpm = 120.0

    res = tm.recompute(tid, "manual_first_beat", 1.0)
    assert res.status == "done"
    # 15 beats over 8s -> first full 8-count phrase kept, 7-beat tail dropped.
    assert len(res.segments) == 1
    assert res.segments[0].startTime == 1.0
    assert len(res.segments[0].beats) == 8


def test_recompute_manual_requires_first_beat(tmp_path, monkeypatch):
    monkeypatch.setattr(TaskManager, "_run_pipeline", lambda self, tid: None)
    tm = TaskManager(tasks_dir=str(tmp_path))
    tid = tm.create_task(video_name="x.mp4")
    tm.get_status(tid).duration = FAKE_DURATION
    with pytest.raises(ValueError):
        tm.recompute(tid, "manual_first_beat")  # missing firstBeatTime


def test_recompute_unknown_task_returns_none(tmp_path):
    tm = TaskManager(tasks_dir=str(tmp_path))
    assert tm.recompute("nope", "fixed120") is None


def test_recompute_persists_to_disk(tmp_path, monkeypatch):
    monkeypatch.setattr(TaskManager, "_run_pipeline", lambda self, tid: None)
    tm = TaskManager(tasks_dir=str(tmp_path))
    tid = tm.create_task(video_name="x.mp4")
    tm.get_status(tid).duration = FAKE_DURATION
    tm.recompute(tid, "fixed120")
    # A fresh manager should load the recomputed result back from JSON.
    tm2 = TaskManager(tasks_dir=str(tmp_path))
    reloaded = tm2.get_status(tid)
    assert reloaded is not None
    assert reloaded.status == "done"
    assert len(reloaded.segments) == 2
