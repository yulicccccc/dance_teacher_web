from __future__ import annotations

import os
import shutil
from pathlib import Path

from app.services.video_preparer import prepare_for_streaming


def test_prepare_for_streaming_moves_moov_before_media(tmp_path):
    from .conftest import SAMPLE_MP4

    source = tmp_path / "iphone.mov"
    shutil.copyfile(SAMPLE_MP4, source)

    prepared = prepare_for_streaming(str(source))

    assert prepared is not None
    assert prepared.endswith(".stream.mp4")
    assert os.path.exists(prepared)
    assert not source.exists()
    payload = Path(prepared).read_bytes()
    assert payload.find(b"moov") >= 0
    assert payload.find(b"mdat") >= 0
    assert payload.find(b"moov") < payload.find(b"mdat")


def test_prepare_for_streaming_keeps_non_mp4_container(tmp_path):
    source = tmp_path / "dance.webm"
    source.write_bytes(b"webm-placeholder")

    assert prepare_for_streaming(str(source)) == str(source)
    assert source.exists()
