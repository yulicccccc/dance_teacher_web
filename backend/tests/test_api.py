"""API contract tests for the FastAPI app (FastAPI TestClient).

Covers health endpoints, 404 for unknown tasks, upload validation errors, and
the recompute endpoint (happy path + 400 mapping). No librosa/ffmpeg required.
"""
from __future__ import annotations

import os
import uuid

import pytest
from fastapi.testclient import TestClient

from app.main import app
from app.core.config import TASKS_DIR
from app.models.task import AnalysisTask
from app.services.task_manager import task_manager

client = TestClient(app)


def test_health_endpoints():
    r = client.get("/health")
    assert r.status_code == 200
    assert r.json() == {"status": "ok", "version": "1.2.6"}
    r2 = client.get("/api/v1/health")
    assert r2.status_code == 200


def test_unknown_task_returns_404_task_not_found():
    r = client.get(f"/api/v1/analysis/{uuid.uuid4()}")
    assert r.status_code == 404
    body = r.json()
    assert body["code"] == "TASK_NOT_FOUND"
    assert body["data"] is None


def test_result_for_unknown_task_returns_404():
    r = client.get(f"/api/v1/analysis/{uuid.uuid4()}/result")
    assert r.status_code == 404
    assert r.json()["code"] == "TASK_NOT_FOUND"


def test_upload_missing_params_returns_400_invalid_request():
    # No body at all -> INVALID_REQUEST
    r = client.post("/api/v1/upload")
    assert r.status_code == 400
    assert r.json()["code"] == "INVALID_REQUEST"
    # Empty JSON body -> also INVALID_REQUEST
    r2 = client.post("/api/v1/upload", json={})
    assert r2.status_code == 400
    assert r2.json()["code"] == "INVALID_REQUEST"


def test_upload_unsupported_format_returns_400(monkeypatch):
    """An out-of-spec file must produce a validation error, never a 500."""
    monkeypatch.setattr(
        task_manager.__class__, "_run_pipeline", lambda self, tid: None
    )
    r = client.post(
        "/api/v1/upload",
        files={"file": ("bad.avi", b"not a real video", "video/x-msvideo")},
    )
    assert r.status_code == 400
    assert r.json()["code"] == "UNSUPPORTED_FORMAT"


def test_upload_valid_mp4_returns_200(monkeypatch):
    """Happy upload path: real mp4 validates and returns a taskId (queued)."""
    monkeypatch.setattr(
        task_manager.__class__, "_run_pipeline", lambda self, tid: None
    )
    from .conftest import SAMPLE_MP4

    with open(SAMPLE_MP4, "rb") as fh:
        r = client.post(
            "/api/v1/upload",
            files={"file": ("sample_5s.mp4", fh, "video/mp4")},
        )
    assert r.status_code == 200
    body = r.json()
    assert "taskId" in body
    assert body["status"] == "queued"
    # clean up the task file created in the singleton store
    p = os.path.join(TASKS_DIR, f"{body['taskId']}.json")
    if os.path.exists(p):
        os.remove(p)
    task_manager._tasks.pop(body["taskId"], None)


def test_chunk_upload_rejects_oversized_file():
    r = client.post(
        "/api/v1/uploads/init",
        json={"filename": "huge.mp4", "size": 501 * 1024 * 1024},
    )
    assert r.status_code == 400
    assert r.json()["code"] == "FILE_TOO_LARGE"


def test_chunk_upload_requires_sequential_exact_chunks():
    payload = b"abcdefgh"
    r = client.post(
        "/api/v1/uploads/init",
        json={"filename": "dance.mp4", "size": len(payload)},
    )
    assert r.status_code == 200
    upload_id = r.json()["uploadId"]

    skipped = client.put(
        f"/api/v1/uploads/{upload_id}/chunks/1",
        content=payload,
        headers={"content-type": "application/octet-stream"},
    )
    assert skipped.status_code == 409
    assert skipped.json()["code"] == "CHUNK_OUT_OF_ORDER"

    short = client.put(
        f"/api/v1/uploads/{upload_id}/chunks/0",
        content=payload[:-1],
        headers={"content-type": "application/octet-stream"},
    )
    assert short.status_code == 400
    assert short.json()["code"] == "INVALID_CHUNK_SIZE"

    incomplete = client.post(
        f"/api/v1/uploads/{upload_id}/complete", json={"totalChunks": 1}
    )
    assert incomplete.status_code == 409
    assert incomplete.json()["code"] == "UPLOAD_INCOMPLETE"


def test_chunk_upload_valid_mp4_is_idempotent(monkeypatch):
    monkeypatch.setattr(
        task_manager.__class__, "_run_pipeline", lambda self, tid: None
    )
    from .conftest import SAMPLE_MP4

    payload = SAMPLE_MP4.read_bytes()
    started = client.post(
        "/api/v1/uploads/init",
        json={"filename": "sample_5s.mp4", "size": len(payload)},
    )
    assert started.status_code == 200
    init = started.json()
    upload_id = init["uploadId"]
    assert init["chunkSize"] == 4 * 1024 * 1024

    part = client.put(
        f"/api/v1/uploads/{upload_id}/chunks/0",
        content=payload,
        headers={"content-type": "application/octet-stream"},
    )
    assert part.status_code == 200
    assert part.json()["received"] == len(payload)

    # A retry after a lost response is acknowledged without appending bytes.
    retried = client.put(
        f"/api/v1/uploads/{upload_id}/chunks/0",
        content=payload,
        headers={"content-type": "application/octet-stream"},
    )
    assert retried.status_code == 200
    assert retried.json()["received"] == len(payload)

    complete = client.post(
        f"/api/v1/uploads/{upload_id}/complete", json={"totalChunks": 1}
    )
    assert complete.status_code == 200
    body = complete.json()
    assert body["status"] == "queued"

    # Completion is also idempotent: no duplicate analysis task is created.
    complete_retry = client.post(
        f"/api/v1/uploads/{upload_id}/complete", json={"totalChunks": 1}
    )
    assert complete_retry.status_code == 200
    assert complete_retry.json()["taskId"] == body["taskId"]

    task_manager._tasks.pop(body["taskId"], None)
    task_path = os.path.join(TASKS_DIR, f"{body['taskId']}.json")
    if os.path.exists(task_path):
        os.remove(task_path)


@pytest.fixture
def injected_task():
    """Inject a pre-built task into the singleton store for recompute tests."""
    tid = f"qa-test-{uuid.uuid4()}"
    task_manager._tasks[tid] = AnalysisTask(
        task_id=tid,
        status="done",
        video_name="x.mp4",
        duration=8.0,
        created_at="2026-07-24T00:00:00Z",
    )
    yield tid
    task_manager._tasks.pop(tid, None)
    p = os.path.join(TASKS_DIR, f"{tid}.json")
    if os.path.exists(p):
        os.remove(p)


def test_api_recompute_fixed120(injected_task):
    r = client.post(
        f"/api/v1/analysis/{injected_task}/recompute", json={"mode": "fixed120"}
    )
    assert r.status_code == 200
    body = r.json()
    assert body["bpm"] == 120.0
    assert len(body["segments"]) == 2
    assert body["segments"][0]["index"] == 1


def test_api_recompute_manual_missing_beat_400(injected_task):
    r = client.post(
        f"/api/v1/analysis/{injected_task}/recompute",
        json={"mode": "manual_first_beat"},
    )
    assert r.status_code == 400
    assert r.json()["code"] == "INVALID_REQUEST"


def test_api_recompute_unknown_task_404():
    r = client.post(
        f"/api/v1/analysis/{uuid.uuid4()}/recompute", json={"mode": "fixed120"}
    )
    assert r.status_code == 404
    assert r.json()["code"] == "TASK_NOT_FOUND"
