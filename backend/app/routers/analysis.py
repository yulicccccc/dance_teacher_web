"""Analysis task status / result / retry / recompute endpoints."""
from __future__ import annotations

from fastapi import APIRouter, HTTPException

from ..core.errors import AppError
from ..schemas.analysis import AnalysisResult, RecomputeRequest, UploadResponse
from ..services.task_manager import task_manager

router = APIRouter(prefix="/api/v1", tags=["analysis"])


@router.get("/analysis/{taskId}")
def get_status(taskId: str) -> dict:
    task = task_manager.get_status(taskId)
    if task is None:
        raise _not_found()
    return task.to_status().model_dump()


@router.get("/analysis/{taskId}/result")
def get_result(taskId: str) -> AnalysisResult:
    task = task_manager.get_status(taskId)
    if task is None:
        raise _not_found()
    if task.status != "done":
        raise AppError(
            code="TASK_NOT_READY",
            message=f"任务尚未完成，当前状态：{task.status}",
            status_code=409,
        )
    return task.to_result()


@router.post("/analysis/{taskId}/retry", response_model=UploadResponse)
def retry(taskId: str) -> UploadResponse:
    if not task_manager.retry(taskId):
        raise _not_found()
    return UploadResponse(taskId=taskId, status="queued")


@router.post("/analysis/{taskId}/recompute", response_model=AnalysisResult)
def recompute(taskId: str, body: RecomputeRequest) -> AnalysisResult:
    # Range guard for the manual-BPM mode. Done at the router layer (not only
    # inside the service) so an out-of-range value returns a clean 422 instead
    # of being swallowed into a 500 by the generic error handler.
    if body.mode == "fixedBpm":
        if body.bpm is None or body.bpm < 40 or body.bpm > 300:
            raise HTTPException(status_code=422, detail="BPM 需在 40–300 之间")
    try:
        task = task_manager.recompute(taskId, body.mode, body.firstBeatTime, body.bpm)
    except ValueError as exc:
        raise AppError(code="INVALID_REQUEST", message=str(exc), status_code=400)
    if task is None:
        raise _not_found()
    return task.to_result()


def _not_found() -> AppError:
    return AppError(code="TASK_NOT_FOUND", message="任务不存在", status_code=404)
