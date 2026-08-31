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

APP_VERSION = "1.2.7"


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


app = FastAPI(title="舞蹈老师 API", version=APP_VERSION, lifespan=lifespan)

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
    return {"status": "ok", "version": APP_VERSION}


# Serve the built frontend from a single port in production, including SPA
# (client-side) deep links such as /analysis/<id>.
#
# On-disk layout:
#   <project_root>/backend/app/main.py   (this file)
#   <project_root>/frontend/dist/        (production build output)
#
# From this file the project root is three directories up
# (app -> backend -> <project_root>). The directory can be overridden with the
# FRONTEND_DIST environment variable for container / custom deployments whose
# layout differs from the default monorepo structure.
_FRONTEND_DIST = os.environ.get("FRONTEND_DIST") or os.path.join(
    os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))),
    "frontend",
    "dist",
)

if os.path.isdir(_FRONTEND_DIST):
    from fastapi import HTTPException
    from fastapi.responses import FileResponse

    _DIST_ABS = os.path.abspath(_FRONTEND_DIST)
    _NO_STORE_HEADERS = {"Cache-Control": "no-store, max-age=0"}
    _IMMUTABLE_HEADERS = {
        "Cache-Control": "public, max-age=31536000, immutable"
    }

    @app.get("/{full_path:path}")
    async def serve_spa(full_path: str) -> FileResponse:
        """Serve real static assets, else fall back to index.html.

        API routes declared above take precedence. Any GET path that maps to a
        real file under the build directory is served directly; every other
        path (including deep client-side links like /analysis/<id>) returns
        index.html so the frontend router can resolve it. Path traversal is
        blocked by verifying the resolved path stays inside the build dir.
        """
        if full_path.startswith("api/"):
            # Unknown API paths must 404 like before, never serve the SPA.
            raise HTTPException(status_code=404, detail="Not Found")

        candidate = os.path.abspath(os.path.join(_DIST_ABS, full_path))
        if (
            full_path
            and candidate.startswith(_DIST_ABS + os.sep)
            and os.path.isfile(candidate)
        ):
            # Vite fingerprints bundled assets, so those are safe to cache.
            # Unfingerprinted files (including replaceable voice samples) must
            # be revalidated on every launch just like the SPA shell.
            headers = (
                _IMMUTABLE_HEADERS
                if full_path.startswith("assets/")
                else _NO_STORE_HEADERS
            )
            return FileResponse(candidate, headers=headers)
        # SPA fallback: index.html for "/" and all unknown non-file paths.
        return FileResponse(
            os.path.join(_DIST_ABS, "index.html"), headers=_NO_STORE_HEADERS
        )
