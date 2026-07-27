"""Application configuration for the Dance Teacher backend.

Centralizes environment limits, CORS settings and on-disk directories so that
every module reads from a single source of truth.
"""
from __future__ import annotations

import os

# backend/  (this file lives in backend/app/core/config.py)
BACKEND_DIR = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

DATA_DIR = os.path.join(BACKEND_DIR, "data")
TASKS_DIR = os.path.join(DATA_DIR, "tasks")
UPLOAD_DIR = os.path.join(DATA_DIR, "uploads")
WAV_DIR = os.path.join(DATA_DIR, "wav")

# Video constraints (PRD §7 / system design §7).
MAX_FILE_MB = 500
MAX_DURATION_SEC = 600  # 10 minutes
ALLOWED_EXTENSIONS = (".mp4", ".webm", ".mov")

# CORS: dev server runs on Vite's default port.
CORS_ORIGINS = [
    "http://localhost:5173",
    "http://127.0.0.1:5173",
]

# Beat-detection tuning.
LOW_CONFIDENCE_THRESHOLD = 0.6  # below this we flag beatLowConfidence
SLOW_BEAT_BPM = 70.0            # below -> likely half-tempo, apply octave up
FAST_BEAT_BPM = 200.0           # above -> likely double-tempo, apply octave down
DEFAULT_BPM = 120.0

# Progress polling interval used by the frontend (ms).
POLL_INTERVAL_MS = 1000


def ensure_dirs() -> None:
    """Create all on-disk directories used at runtime (idempotent)."""
    for directory in (DATA_DIR, TASKS_DIR, UPLOAD_DIR, WAV_DIR):
        os.makedirs(directory, exist_ok=True)
