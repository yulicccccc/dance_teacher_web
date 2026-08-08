"""Extract a normalized mono 16kHz / 16bit WAV from a video using ffmpeg.

We shell out to the system `ffmpeg` (via subprocess) rather than letting
librosa read the container directly, because ffmpeg is far more robust across
mp4 / webm / mov and lets us pin a single canonical audio format downstream.
"""
from __future__ import annotations

import os
import subprocess
from typing import Optional

from ..core.config import WAV_DIR


def extract(video_path: str, wav_path: Optional[str] = None) -> str:
    """Extract audio and return the path to the produced WAV file."""
    os.makedirs(WAV_DIR, exist_ok=True)
    if wav_path is None:
        name = os.path.splitext(os.path.basename(video_path))[0] + ".wav"
        wav_path = os.path.join(WAV_DIR, name)

    cmd = [
        "ffmpeg",
        "-y",
        "-i",
        video_path,
        "-vn",  # drop video
        "-ac",
        "1",  # mono
        "-ar",
        "16000",  # 16 kHz
        "-sample_fmt",
        "s16",  # 16-bit PCM
        wav_path,
    ]
    proc = subprocess.run(cmd, capture_output=True, text=True, timeout=300)
    if proc.returncode != 0:
        raise RuntimeError(f"ffmpeg 提取音频失败：{proc.stderr[-500:]}")
    if not os.path.exists(wav_path):
        raise RuntimeError("ffmpeg 未生成 wav 文件")
    return wav_path
