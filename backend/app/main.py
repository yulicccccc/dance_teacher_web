"""FastAPI application entry point for the Dance Teacher backend."""
from __future__ import annotations

import os
from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from .core.config import CORS_ORIGINS, ensure_dirs
from .core.errors import AppError, app_error_handler
from .routers import analysis, upload

ensure_dirs()


@asynccontextmanager
async def lifespan(app: FastAPI):
    """Startup / shutdown hook.

    The background pipeline runs ``detect()`` inside a uvicorn daemon thread.
    librosa's ``onset_strength`` / ``beat_track`` / ``onset_detect`` trigger a
    numba/llvmlite JIT on their *first* call, and that first compile deadlocks
    inside a daemon thread — hanging the pipeline at ``beat_detecting`` forever.

    We pre-compile those functions here, on the worker's *main* thread (the
    lifespan startup runs in the event loop's main thread). The compiled
    Dispatchers are cached in-process, so every later daemon-thread call reuses
    them instead of re-entering the JIT compiler.

    The whole thing is wrapped defensively: a failed warmup must never prevent
    the app from booting.
    """
    try:
        from .services.beat_detector import warmup

        warmup()
    except Exception:
        pass
    yield


app = FastAPI(title="舞蹈老师 API", version="0.1.0", lifespan=lifespan)

app.add_middleware(
    CORSMiddleware,
    allow_origins=CORS_ORIGINS,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

app.add_exception_handler(AppError, app_error_handler)

app.include_router(upload.router)
app.include_router(analysis.router)


@app.get("/health")
@app.get("/api/v1/health")
def health() -> dict:
    return {"status": "ok"}


# Optional: serve the built frontend in production (single-port deploy).
_FRONTEND_DIST = os.path.join(
    os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "frontend", "dist"
)
if os.path.isdir(_FRONTEND_DIST):
    from fastapi.staticfiles import StaticFiles

    app.mount("/", StaticFiles(directory=_FRONTEND_DIST, html=True), name="static")
