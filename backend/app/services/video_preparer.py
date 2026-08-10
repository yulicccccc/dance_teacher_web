"""Prepare uploaded MP4/MOV files for low-latency browser streaming.

iPhone screen recordings commonly put the MP4/MOV ``moov`` index after the
large media payload. A local browser can scan that file almost instantly, but a
remote browser may need to download the entire video before it can even learn
the duration. ``ffmpeg -c copy -movflags +faststart`` moves only the container
index to the front; it does not re-encode the audio or video streams.
"""
from __future__ import annotations

import os
import subprocess
from typing import Optional


def prepare_for_streaming(video_path: Optional[str]) -> Optional[str]:
    """Return a stream-friendly path, falling back to the original on failure."""
    if not video_path or not os.path.isfile(video_path):
        return video_path

    ext = os.path.splitext(video_path)[1].lower()
    if ext not in {".mp4", ".mov"}:
        return video_path

    output_path = f"{os.path.splitext(video_path)[0]}.stream.mp4"
    cmd = [
        "ffmpeg",
        "-y",
        "-i",
        video_path,
        "-map",
        "0",
        "-c",
        "copy",
        "-movflags",
        "+faststart",
        output_path,
    ]
    try:
        proc = subprocess.run(cmd, capture_output=True, text=True, timeout=300)
        if proc.returncode != 0 or not os.path.isfile(output_path):
            _safe_remove(output_path)
            return video_path
        if os.path.getsize(output_path) <= 0:
            _safe_remove(output_path)
            return video_path
        _safe_remove(video_path)
        return output_path
    except (OSError, subprocess.SubprocessError):
        _safe_remove(output_path)
        return video_path


def _safe_remove(path: str) -> None:
    try:
        os.remove(path)
    except OSError:
        pass
