"""Tests for app.utils.video — format / size / duration validation.

ffmpeg & ffprobe are present in this sandbox, so format + real-duration
detection are exercised against a real generated clip. Size and the >10min
duration boundary are driven by monkeypatching the cheap probe/getsize helpers.
"""
from __future__ import annotations

import os
import shutil

import pytest

from app.utils import video as video_utils
from app.utils.video import VideoValidationError, validate_file

from .conftest import SAMPLE_MP4


def _touch(tmp_path, name: str, size: int | None = None) -> str:
    p = tmp_path / name
    if size is None:
        p.write_bytes(b"\x00\x01\x02\x03")
    else:
        with open(p, "wb") as fh:  # sparse file of requested byte size
            fh.truncate(size)
    return str(p)


def test_validate_allowed_formats_pass(tmp_path):
    for ext in (".mp4", ".webm", ".mov"):
        p = _touch(tmp_path, f"clip{ext}")
        info = validate_file(p, f"clip{ext}")
        assert info["ext"] == ext


def test_validate_rejects_unsupported_format(tmp_path):
    p = _touch(tmp_path, "clip.avi")
    with pytest.raises(VideoValidationError) as exc:
        validate_file(p, "clip.avi")
    assert exc.value.code == "UNSUPPORTED_FORMAT"


def test_validate_rejects_uppercase_format(tmp_path):
    p = _touch(tmp_path, "CLIP.MP4X")
    with pytest.raises(VideoValidationError) as exc:
        validate_file(p, "CLIP.MP4X")
    assert exc.value.code == "UNSUPPORTED_FORMAT"


def test_validate_real_mp4_passes(tmp_path):
    """A real ffmpeg-generated clip should pass format + size + duration checks."""
    dest = tmp_path / "sample_5s.mp4"
    shutil.copy(SAMPLE_MP4, dest)
    info = validate_file(str(dest), "sample_5s.mp4")
    assert info["ext"] == ".mp4"
    # ffprobe should report ~5s (the generated clip is 5s long).
    assert info["duration"] is not None
    assert 4.5 <= info["duration"] <= 5.5


def test_validate_rejects_too_large(tmp_path, monkeypatch):
    p = _touch(tmp_path, "big.mp4")
    monkeypatch.setattr("os.path.getsize", lambda _p: 600 * 1024 * 1024)  # 600 MB
    with pytest.raises(VideoValidationError) as exc:
        validate_file(p, "big.mp4")
    assert exc.value.code == "FILE_TOO_LARGE"


def test_validate_rejects_too_long(tmp_path, monkeypatch):
    p = _touch(tmp_path, "long.mp4")
    monkeypatch.setattr(video_utils, "_probe_duration", lambda _p: 700.0)
    with pytest.raises(VideoValidationError) as exc:
        validate_file(p, "long.mp4")
    assert exc.value.code == "FILE_TOO_LONG"


def test_validate_duration_just_under_limit_passes(tmp_path, monkeypatch):
    p = _touch(tmp_path, "ok.mp4")
    monkeypatch.setattr(video_utils, "_probe_duration", lambda _p: 599.0)
    info = validate_file(p, "ok.mp4")
    assert info["duration"] == 599.0


def test_probe_duration_returns_none_when_ffprobe_missing(monkeypatch):
    """If ffprobe is unavailable the duration probe must degrade gracefully."""
    def _raise(*a, **k):
        raise FileNotFoundError()

    monkeypatch.setattr(video_utils.subprocess, "run", _raise)
    assert video_utils._probe_duration("/tmp/whatever.mp4") is None
