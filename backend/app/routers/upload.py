"""Video upload + streaming endpoints (local file or remote URL)."""
from __future__ import annotations

import json
import math
import os
import time
import uuid
from typing import Optional

from fastapi import APIRouter, File, Request, UploadFile
from fastapi.responses import FileResponse

from ..core.config import (
    ALLOWED_EXTENSIONS,
    MAX_FILE_MB,
    UPLOAD_CHUNK_BYTES,
    UPLOAD_DIR,
)
from ..core.errors import AppError
from ..schemas.analysis import (
    ChunkUploadCompleteRequest,
    ChunkUploadInitRequest,
    ChunkUploadInitResponse,
    ChunkUploadPartResponse,
    UploadResponse,
)
from ..services.task_manager import task_manager
from ..utils import video as video_utils

router = APIRouter(prefix="/api/v1", tags=["upload"])

_CHUNK_META_PREFIX = ".chunk-upload-"
_CHUNK_META_SUFFIX = ".json"
_CHUNK_PART_SUFFIX = ".part"
_STALE_UPLOAD_SECONDS = 24 * 60 * 60


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


@router.post("/uploads/init", response_model=ChunkUploadInitResponse)
def init_chunk_upload(body: ChunkUploadInitRequest) -> ChunkUploadInitResponse:
    """Start a resumable upload whose requests stay small enough for mobile/CDN links."""
    filename = os.path.basename(body.filename.strip())
    ext = os.path.splitext(filename)[1].lower()
    max_bytes = MAX_FILE_MB * 1024 * 1024
    if not filename or ext not in ALLOWED_EXTENSIONS:
        raise _http_error(
            400,
            "UNSUPPORTED_FORMAT",
            f"不支持的格式：{ext or '无扩展名'}，请上传 mp4/webm/mov",
        )
    if body.size <= 0:
        raise _http_error(400, "INVALID_REQUEST", "文件大小必须大于 0")
    if body.size > max_bytes:
        raise _http_error(
            400,
            "FILE_TOO_LARGE",
            f"文件过大：{body.size / 1024 / 1024:.1f}MB，上限 {MAX_FILE_MB}MB",
        )

    os.makedirs(UPLOAD_DIR, exist_ok=True)
    _cleanup_stale_chunk_uploads()
    upload_id = str(uuid.uuid4())
    meta = {
        "uploadId": upload_id,
        "filename": filename,
        "size": body.size,
        "bytesReceived": 0,
        "nextIndex": 0,
        "createdAt": time.time(),
        "completedTaskId": None,
    }
    _write_chunk_meta(upload_id, meta)
    # Create the part file now so an unknown/expired id can never create files
    # merely by hitting the chunk route.
    with open(_chunk_part_path(upload_id), "wb"):
        pass
    return ChunkUploadInitResponse(uploadId=upload_id, chunkSize=UPLOAD_CHUNK_BYTES)


@router.put(
    "/uploads/{upload_id}/chunks/{index}",
    response_model=ChunkUploadPartResponse,
)
async def upload_chunk(
    upload_id: str, index: int, request: Request
) -> ChunkUploadPartResponse:
    """Append one exact-size chunk; retrying an accepted index is idempotent."""
    meta = _load_chunk_meta(upload_id)
    if meta.get("completedTaskId"):
        raise _http_error(409, "UPLOAD_COMPLETE", "该文件已经上传完成")
    next_index = int(meta["nextIndex"])
    bytes_received = int(meta["bytesReceived"])
    total_size = int(meta["size"])

    if index < next_index:
        return ChunkUploadPartResponse(
            uploadId=upload_id, index=index, received=bytes_received
        )
    if index != next_index:
        raise _http_error(
            409,
            "CHUNK_OUT_OF_ORDER",
            f"分片顺序错误：应上传 {next_index}，收到 {index}",
        )

    expected_size = min(UPLOAD_CHUNK_BYTES, total_size - bytes_received)
    if expected_size <= 0:
        raise _http_error(409, "UPLOAD_COMPLETE", "文件内容已经接收完毕")
    content_length = request.headers.get("content-length")
    if content_length:
        try:
            if int(content_length) != expected_size:
                raise _http_error(
                    400,
                    "INVALID_CHUNK_SIZE",
                    f"分片大小错误：应为 {expected_size} 字节",
                )
        except ValueError:
            raise _http_error(400, "INVALID_CHUNK_SIZE", "无效的分片大小")

    path = _chunk_part_path(upload_id)
    written = 0
    try:
        with open(path, "r+b") as out:
            # Roll back any bytes left by an interrupted previous attempt.
            out.seek(bytes_received)
            out.truncate()
            async for data in request.stream():
                if not data:
                    continue
                written += len(data)
                if written > expected_size:
                    out.truncate(bytes_received)
                    raise _http_error(
                        400,
                        "INVALID_CHUNK_SIZE",
                        f"分片超过 {expected_size} 字节",
                    )
                out.write(data)
            if written != expected_size:
                out.truncate(bytes_received)
                raise _http_error(
                    400,
                    "INVALID_CHUNK_SIZE",
                    f"分片不完整：收到 {written} / {expected_size} 字节",
                )
    except AppError:
        raise
    except (OSError, RuntimeError) as exc:
        # Preserve the last committed byte boundary so this exact index can be
        # retried safely after a network reset.
        try:
            with open(path, "r+b") as out:
                out.truncate(bytes_received)
        except OSError:
            pass
        raise _http_error(500, "CHUNK_WRITE_FAILED", f"分片保存失败：{exc}")

    meta["bytesReceived"] = bytes_received + written
    meta["nextIndex"] = next_index + 1
    _write_chunk_meta(upload_id, meta)
    return ChunkUploadPartResponse(
        uploadId=upload_id,
        index=index,
        received=int(meta["bytesReceived"]),
    )


@router.post(
    "/uploads/{upload_id}/complete",
    response_model=UploadResponse,
)
def complete_chunk_upload(
    upload_id: str, body: ChunkUploadCompleteRequest
) -> UploadResponse:
    """Validate the assembled video and enqueue high-accuracy analysis."""
    meta = _load_chunk_meta(upload_id)
    completed_task_id = meta.get("completedTaskId")
    if completed_task_id:
        return UploadResponse(taskId=completed_task_id, status="queued")

    total_size = int(meta["size"])
    expected_chunks = math.ceil(total_size / UPLOAD_CHUNK_BYTES)
    if (
        body.totalChunks != expected_chunks
        or int(meta["nextIndex"]) != expected_chunks
        or int(meta["bytesReceived"]) != total_size
    ):
        raise _http_error(
            409,
            "UPLOAD_INCOMPLETE",
            f"文件尚未上传完整：{meta['bytesReceived']} / {total_size} 字节",
        )

    source = _chunk_part_path(upload_id)
    ext = os.path.splitext(str(meta["filename"]))[1].lower()
    final_path = os.path.join(UPLOAD_DIR, f"{uuid.uuid4()}{ext}")
    try:
        os.replace(source, final_path)
        video_utils.validate_file(final_path, str(meta["filename"]))
    except video_utils.VideoValidationError as exc:
        _safe_remove(final_path)
        raise _http_error(400, exc.code, exc.message)
    except OSError as exc:
        _safe_remove(final_path)
        raise _http_error(500, "UPLOAD_FINALIZE_FAILED", f"文件合并失败：{exc}")

    task_id = task_manager.create_task(
        video_name=str(meta["filename"]), video_path=final_path
    )
    # Retain the completed task id briefly so a lost completion response can be
    # retried without starting duplicate analysis.
    meta["completedTaskId"] = task_id
    meta["finalPath"] = final_path
    _write_chunk_meta(upload_id, meta)
    return UploadResponse(taskId=task_id, status="queued")


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
    # This route is a media source, not a download action. Omitting `filename`
    # prevents Starlette from adding `Content-Disposition: attachment`, which
    # can make remote Safari/Chrome defer or reject metadata loading.
    return FileResponse(task.video_path, media_type=media)


def _safe_remove(path: str) -> None:
    try:
        os.remove(path)
    except OSError:
        pass


def _normalise_upload_id(upload_id: str) -> str:
    try:
        parsed = uuid.UUID(upload_id)
    except (ValueError, AttributeError):
        raise _http_error(404, "UPLOAD_NOT_FOUND", "上传会话不存在或已过期")
    value = str(parsed)
    if value != upload_id.lower():
        raise _http_error(404, "UPLOAD_NOT_FOUND", "上传会话不存在或已过期")
    return value


def _chunk_meta_path(upload_id: str) -> str:
    value = _normalise_upload_id(upload_id)
    return os.path.join(UPLOAD_DIR, f"{_CHUNK_META_PREFIX}{value}{_CHUNK_META_SUFFIX}")


def _chunk_part_path(upload_id: str) -> str:
    value = _normalise_upload_id(upload_id)
    return os.path.join(UPLOAD_DIR, f"{_CHUNK_META_PREFIX}{value}{_CHUNK_PART_SUFFIX}")


def _load_chunk_meta(upload_id: str) -> dict:
    path = _chunk_meta_path(upload_id)
    try:
        with open(path, "r", encoding="utf-8") as fh:
            meta = json.load(fh)
    except (OSError, ValueError, TypeError):
        raise _http_error(404, "UPLOAD_NOT_FOUND", "上传会话不存在或已过期")
    if meta.get("uploadId") != _normalise_upload_id(upload_id):
        raise _http_error(404, "UPLOAD_NOT_FOUND", "上传会话不存在或已过期")
    return meta


def _write_chunk_meta(upload_id: str, meta: dict) -> None:
    path = _chunk_meta_path(upload_id)
    temp_path = f"{path}.tmp"
    with open(temp_path, "w", encoding="utf-8") as fh:
        json.dump(meta, fh, ensure_ascii=False)
    os.replace(temp_path, path)


def _cleanup_stale_chunk_uploads() -> None:
    cutoff = time.time() - _STALE_UPLOAD_SECONDS
    try:
        names = os.listdir(UPLOAD_DIR)
    except OSError:
        return
    for name in names:
        if not (name.startswith(_CHUNK_META_PREFIX) and name.endswith(_CHUNK_META_SUFFIX)):
            continue
        meta_path = os.path.join(UPLOAD_DIR, name)
        try:
            if os.path.getmtime(meta_path) >= cutoff:
                continue
        except OSError:
            continue
        upload_id = name[len(_CHUNK_META_PREFIX) : -len(_CHUNK_META_SUFFIX)]
        _safe_remove(meta_path)
        try:
            _safe_remove(_chunk_part_path(upload_id))
        except AppError:
            pass


def _http_error(status: int, code: str, message: str) -> AppError:
    return AppError(code=code, message=message, status_code=status)


def _not_found() -> AppError:
    return AppError(code="TASK_NOT_FOUND", message="任务不存在", status_code=404)
