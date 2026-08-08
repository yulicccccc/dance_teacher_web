"""Shared pytest fixtures for the Dance Teacher backend test suite.

Test isolation
--------------
The suite must NEVER touch the real ``backend/data/`` tree. It used to: an
autouse fixture wiped ``TASKS_DIR`` / ``UPLOAD_DIR`` / ``WAV_DIR`` straight from
``app.core.config`` before and after every single test, and since
``backend/data/`` is gitignored, one ``pytest`` run permanently destroyed every
uploaded video and analysis result on the machine.

The fix is to redirect the data root *before any app module is imported*, via
the ``DANCE_DATA_DIR`` env var that ``app.core.config`` reads. Patching the
constants afterwards would not work, because:

  * ``task_manager`` / ``audio_extractor`` / ``utils.video`` / ``routers.upload``
    bind them at import time with ``from ..core.config import WAV_DIR``;
  * ``TaskManager.__init__`` captures ``TASKS_DIR`` as a **default argument**,
    which is evaluated once at def-time;
  * ``task_manager`` is a module-level singleton that calls ``ensure_dirs()``
    and scans the tasks dir while it is being imported.

Setting the env var first makes every one of those bindings be born pointing at
the temp dir, so no per-module patching is needed at all.

``_assert_data_dirs_isolated`` (autouse, session-scoped) is the guard that keeps
this property from silently regressing, and ``test_conftest_isolation.py`` is
the end-to-end sentinel proving the real data dir survives a full run.
"""
from __future__ import annotations

import os
import shutil
import sys
import tempfile
from pathlib import Path

import pytest

# Make `backend/` importable as a package root so `import app` works.
BACKEND_DIR = Path(__file__).resolve().parent.parent
if str(BACKEND_DIR) not in sys.path:
    sys.path.insert(0, str(BACKEND_DIR))

# --- Redirect the data root BEFORE importing anything from `app` -------------
# This runs at conftest import time, which pytest guarantees happens before any
# test module (and therefore before any `app.*` module) is imported.
_TMP_DATA_ROOT = tempfile.mkdtemp(prefix="dance-teacher-test-data-")
os.environ["DANCE_DATA_DIR"] = _TMP_DATA_ROOT

# The real, production data root — imported *only* so tests can assert we are
# not touching it. Computed exactly like config.py does when the env var is absent.
REAL_DATA_DIR = str(BACKEND_DIR / "data")

from app.core.config import DATA_DIR, TASKS_DIR, UPLOAD_DIR, WAV_DIR  # noqa: E402

FIXTURES = BACKEND_DIR / "tests" / "fixtures"
SAMPLE_MP4 = FIXTURES / "sample_5s.mp4"
SAMPLE_WAV = FIXTURES / "sample_1s.wav"


def _wipe(directory: str) -> None:
    """Remove every file in ``directory`` (non-recursive), ignoring errors."""
    if not os.path.isdir(directory):
        return
    for name in os.listdir(directory):
        try:
            os.remove(os.path.join(directory, name))
        except OSError:
            pass


@pytest.fixture(scope="session", autouse=True)
def _assert_data_dirs_isolated():
    """Fail the whole session if the data dirs are not inside the temp root.

    This is the tripwire for the bug described in the module docstring: if a
    future change makes `app.core.config` ignore DANCE_DATA_DIR, or something
    imports `app` before this conftest runs, we abort loudly instead of quietly
    deleting the user's uploads.
    """
    for d in (DATA_DIR, TASKS_DIR, UPLOAD_DIR, WAV_DIR):
        assert str(d).startswith(_TMP_DATA_ROOT), (
            f"test data dir {d!r} is NOT inside the temp root {_TMP_DATA_ROOT!r}. "
            "Refusing to run: the suite would wipe real user data."
        )
    assert not str(DATA_DIR).startswith(REAL_DATA_DIR), (
        f"test DATA_DIR {DATA_DIR!r} resolves into the real data dir {REAL_DATA_DIR!r}"
    )
    yield
    shutil.rmtree(_TMP_DATA_ROOT, ignore_errors=True)


@pytest.fixture(autouse=True)
def _clean_data_dirs():
    """Keep the (temp) data dirs empty around every test.

    The module-level `task_manager` singleton would otherwise pick up stale
    artifacts between tests. Now scoped to the temp root, so this is safe.
    """
    for d in (TASKS_DIR, UPLOAD_DIR, WAV_DIR):
        os.makedirs(d, exist_ok=True)
        _wipe(d)
    yield
    for d in (TASKS_DIR, UPLOAD_DIR, WAV_DIR):
        _wipe(d)
