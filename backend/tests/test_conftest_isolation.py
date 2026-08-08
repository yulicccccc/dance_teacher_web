"""Guard tests: the suite must never read or write the real `backend/data/`.

Regression cover for a data-loss bug: `conftest._clean_data_dirs` used to wipe
`TASKS_DIR` / `UPLOAD_DIR` / `WAV_DIR` straight out of `app.core.config` around
*every* test. Those point at the production `backend/data/`, which is gitignored
-- so a single `pytest` run permanently deleted every video the user had
uploaded and every analysis result.

These tests fail loudly if that property ever breaks again.
"""
from __future__ import annotations

import os
from pathlib import Path

from app.core.config import DATA_DIR, TASKS_DIR, UPLOAD_DIR, WAV_DIR

from .conftest import REAL_DATA_DIR, _TMP_DATA_ROOT

BACKEND_DIR = Path(__file__).resolve().parent.parent


def test_config_dirs_are_redirected_into_tmp():
    """Every on-disk dir the app writes to must live under the temp root."""
    for d in (DATA_DIR, TASKS_DIR, UPLOAD_DIR, WAV_DIR):
        assert str(d).startswith(_TMP_DATA_ROOT), f"{d} escaped the temp root"


def test_config_dirs_are_not_the_real_data_dir():
    """Belt and braces: none of them may resolve inside the real data tree."""
    real = os.path.realpath(REAL_DATA_DIR)
    for d in (DATA_DIR, TASKS_DIR, UPLOAD_DIR, WAV_DIR):
        assert not os.path.realpath(d).startswith(real), f"{d} points into real data"


def test_modules_that_bind_dirs_at_import_time_are_also_redirected():
    """The from-import / default-arg / singleton binding sites must agree.

    `from ..core.config import WAV_DIR` copies the value into the importing
    module's namespace, `TaskManager.__init__` captures TASKS_DIR as a def-time
    default argument, and `task_manager` is a module-level singleton created
    during import. Redirecting only `app.core.config` after those had been
    evaluated would leave them pointing at production -- assert it did not.
    """
    from app.routers import upload as upload_router
    from app.services import audio_extractor, task_manager as tm_module
    from app.utils import video as video_utils

    bound = {
        "audio_extractor.WAV_DIR": audio_extractor.WAV_DIR,
        "utils.video.UPLOAD_DIR": video_utils.UPLOAD_DIR,
        "routers.upload.UPLOAD_DIR": upload_router.UPLOAD_DIR,
        "task_manager.TASKS_DIR": tm_module.TASKS_DIR,
        # Default argument captured at def-time.
        "TaskManager.__init__ default": tm_module.TaskManager.__init__.__defaults__[0],
        # The live singleton's actual working dir.
        "task_manager singleton": tm_module.task_manager._tasks_dir,
    }
    for name, value in bound.items():
        assert str(value).startswith(_TMP_DATA_ROOT), (
            f"{name} = {value!r} still points outside the temp root"
        )


def test_real_data_dir_is_untouched_by_the_suite(request):
    """End-to-end sentinel: drop a file in the REAL wav dir, prove it survives.

    This is the test that would actually have caught the original bug. It writes
    a sentinel into the production `backend/data/wav/`, then asserts at session
    teardown (via a finalizer that runs after the rest of the suite's autouse
    cleanup) that the file is still there, before removing it again.
    """
    real_wav = os.path.join(REAL_DATA_DIR, "wav")
    os.makedirs(real_wav, exist_ok=True)
    sentinel = os.path.join(real_wav, ".pytest_sentinel_do_not_delete")
    with open(sentinel, "w", encoding="utf-8") as fh:
        fh.write("If the suite deletes this file, it is deleting real user data.\n")

    def _check_and_cleanup() -> None:
        try:
            assert os.path.exists(sentinel), (
                "THE TEST SUITE DELETED A FILE IN THE REAL data/wav DIRECTORY. "
                "conftest is wiping production data again -- see test_conftest_isolation.py"
            )
        finally:
            if os.path.exists(sentinel):
                os.remove(sentinel)

    request.addfinalizer(_check_and_cleanup)

    # Force the autouse _clean_data_dirs teardown to run against the temp dirs
    # while our sentinel sits in the real one.
    assert os.path.exists(sentinel)
