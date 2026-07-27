"""Video upload + streaming endpoints (local file or remote URL)."""
from __future__ import annotations

import os
import uuid
from typing import Optional

from fastapi import APIRouter, File, Request, UploadFile
from fastapi.responses import FileResponse

from ..core.config import UPLOAD_DIR
from ..core.errors import AppError
from ..schemas.analysis import UploadResponse
from ..services.task_manager import task_manager
from ..utils import video as video_utils

router = APIRouter(prefix="/api/v1", tags=["upload"])


@router.post("/upload", response_model=UploadResponse)
async def upload(
    request: Request, file: Optional[UploadFile] = File(None)
) -> UploadResponse:
    content_type = request.headers.get("content-type", "")

    # --- Path A: multipart file upload -------------------------------
    if file is not None and file.filename:
        ext = os.path.splitext(file.filename)[1]
        safe_name = f"{uuid.uuid4()}{ext}"
        path = os.path.join(UPLOAD_DIR, safe_name)
        os.makedirs(UPLOAD_DIR, exist_ok=True)
        with open(path, "wb") as out:
            while chunk := await file.read(1024 * 1024):
                out.write(chunk)
        try:
            video_utils.validate_file(path, file.filename)
        except video_utils.VideoValidationError as exc:
            _safe_remove(path)
            raise _http_error(400, exc.code, exc.message)
        task_id = task_manager.create_task(video_name=file.filename, video_path=path)
        return UploadResponse(taskId=task_id, status="queued")

    # --- Path B: JSON body { url } -----------------------------------
    if "application/json" in content_type or "form" not in content_type:
        try:
            body = await request.json()
        except Exception:
            body = {}
        url = (body or {}).get("url")
        if url:
            try:
                path, filename = video_utils.download_video(url)
            except Exception as exc:
                raise _http_error(400, "DOWNLOAD_FAILED", f"下载失败：{exc}")
            try:
                video_utils.validate_file(path, filename)
            except video_utils.VideoValidationError as exc:
                _safe_remove(path)
                raise _http_error(400, exc.code, exc.message)
            task_id = task_manager.create_task(
                video_name=filename, video_path=path, source_url=url
            )
            return UploadResponse(taskId=task_id, status="queued")

    raise _http_error(400, "INVALID_REQUEST", "请提供文件（multipart）或 JSON { url }")


@router.get("/video/{taskId}")
def get_video(taskId: str) -> FileResponse:
    """Stream the source video for the lesson player (range requests supported)."""
    task = task_manager.get_status(taskId)
    if task is None or not task.video_path or not os.path.exists(task.video_path):
        raise _not_found()
    media = {
        ".mp4": "video/mp4",
        ".webm": "video/webm",
        ".mov": "video/quicktime",
    }.get(os.path.splitext(task.video_path)[1].lower(), "video/mp4")
    return FileResponse(task.video_path, media_type=media, filename=task.video_name)


def _safe_remove(path: str) -> None:
    try:
        os.remove(path)
    except OSError:
        pass


def _http_error(status: int, code: str, message: str) -> AppError:
    return AppError(code=code, message=message, status_code=status)


def _not_found() -> AppError:
    return AppError(code="TASK_NOT_FOUND", message="任务不存在", status_code=404)
