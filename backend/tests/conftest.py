"""Shared pytest fixtures for the Dance Teacher backend test suite.

Keeps the on-disk data dirs (tasks / uploads / wav) clean so the module-level
`task_manager` singleton never picks up stale artifacts between tests.
"""
from __future__ import annotations

import os
import sys
import tempfile
from pathlib import Path

import pytest

# Make `backend/` importable as a package root so `import app` works.
BACKEND_DIR = Path(__file__).resolve().parent.parent
if str(BACKEND_DIR) not in sys.path:
    sys.path.insert(0, str(BACKEND_DIR))

# Never point test cleanup at the user's real backend/data directory. Config is
# imported below, so setting the override here gives every module-level service
# singleton an isolated process-scoped data root.
_TEST_DATA_DIR = tempfile.TemporaryDirectory(prefix="dance-teacher-tests-")
os.environ["DANCE_TEACHER_DATA_DIR"] = _TEST_DATA_DIR.name

from app.core.config import TASKS_DIR, UPLOAD_DIR, WAV_DIR  # noqa: E402

FIXTURES = BACKEND_DIR / "tests" / "fixtures"
SAMPLE_MP4 = FIXTURES / "sample_5s.mp4"
SAMPLE_WAV = FIXTURES / "sample_1s.wav"


def _wipe(directory: str) -> None:
    if not os.path.isdir(directory):
        return
    for name in os.listdir(directory):
        try:
            os.remove(os.path.join(directory, name))
        except OSError:
            pass


@pytest.fixture(autouse=True)
def _clean_data_dirs():
    for d in (TASKS_DIR, UPLOAD_DIR, WAV_DIR):
        _wipe(d)
    yield
    for d in (TASKS_DIR, UPLOAD_DIR, WAV_DIR):
        _wipe(d)
