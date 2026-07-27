"""Video validation and download helpers.

All checks use ffmpeg/ffprobe via subprocess. If ffprobe is unavailable the
duration check is skipped (the analysis pipeline will surface a clear error
later), so the API can still boot on a machine without ffmpeg installed.
"""
from __future__ import annotations

import json
import os
import subprocess
import tempfile
import urllib.parse
import urllib.request
from typing import Optional, Tuple

from ..core.config import ALLOWED_EXTENSIONS, MAX_DURATION_SEC, MAX_FILE_MB, UPLOAD_DIR


class VideoValidationError(Exception):
    """Raised when a video fails a hard constraint (format / size / duration)."""

    def __init__(self, code: str, message: str) -> None:
        super().__init__(message)
        self.code = code
        self.message = message


def _probe_duration(path: str) -> Optional[float]:
    """Return video duration in seconds via ffprobe, or None if unavailable."""
    try:
        cmd = [
            "ffprobe",
            "-v",
            "error",
            "-show_entries",
            "format=duration",
            "-of",
            "json",
            path,
        ]
        out = subprocess.run(cmd, capture_output=True, text=True, timeout=30)
        info = json.loads(out.stdout or "{}")
        duration = info.get("format", {}).get("duration")
        return float(duration) if duration is not None else None
    except Exception:  # ffprobe missing or not a media file
        return None


def validate_file(path: str, filename: str) -> dict:
    """Validate a local video file. Raises VideoValidationError on failure."""
    ext = os.path.splitext(filename)[1].lower()
    if ext not in ALLOWED_EXTENSIONS:
        raise VideoValidationError(
            "UNSUPPORTED_FORMAT",
            f"不支持的格式：{ext or '未知'}（仅支持 mp4 / webm / mov）",
        )
    size_mb = os.path.getsize(path) / (1024 * 1024)
    if size_mb > MAX_FILE_MB:
        raise VideoValidationError(
            "FILE_TOO_LARGE", f"文件过大：{size_mb:.1f}MB，上限 {MAX_FILE_MB}MB"
        )
    duration = _probe_duration(path)
    if duration is not None and duration > MAX_DURATION_SEC:
        raise VideoValidationError(
            "FILE_TOO_LONG", f"视频过长：{duration:.1f}s，上限 {MAX_DURATION_SEC}s"
        )
    return {"duration": duration, "sizeMb": round(size_mb, 2), "ext": ext}


def download_video(url: str) -> Tuple[str, str]:
    """Download a remote video to the upload dir; returns (path, filename)."""
    os.makedirs(UPLOAD_DIR, exist_ok=True)
    parsed = urllib.parse.urlparse(url)
    base = os.path.basename(parsed.path) or "video"
    if "." not in base:
        base += ".mp4"
    name, ext = os.path.splitext(base)
    filename = f"{name}_{abs(hash(url))}{ext}"
    path = os.path.join(UPLOAD_DIR, filename)
    urllib.request.urlretrieve(url, path)  # noqa: S310 - local-first tool
    return path, filename
