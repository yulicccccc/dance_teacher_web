# =============================================================================
# Multi-stage build for single-port deployment.
#
# Stage 1 (frontend-build): compiles the React SPA into frontend/dist.
# Stage 2 (runtime):        the FastAPI backend, which ALSO serves the built
#                           SPA from the same port via StaticFiles (see
#                           backend/app/main.py). No separate web server / CDN
#                           is required — one container, one port.
# =============================================================================

# ---------------------------------------------------------------------------
# Stage 1: build the frontend production bundle.
# ---------------------------------------------------------------------------
FROM node:22-slim AS frontend-build

WORKDIR /frontend

# Install dependencies first so this layer is cached across source changes.
COPY frontend/package.json frontend/package-lock.json* ./
RUN npm ci || npm install

# Build the app (tsc -b && vite build -> /frontend/dist).
COPY frontend/ ./
RUN npm run build


# ---------------------------------------------------------------------------
# Stage 2: python backend that also serves the SPA on a single port.
# ---------------------------------------------------------------------------
FROM python:3.11-slim

ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    # Tell backend/app/main.py where the built SPA lives inside the container.
    # This matches the default resolution (three dirs up from
    # /app/app/main.py -> /, then frontend/dist) but is set explicitly so the
    # layout is unambiguous and container/custom deployments stay robust.
    FRONTEND_DIST=/frontend/dist

# ffmpeg is required by librosa / soundfile for audio decoding.
RUN apt-get update \
    && apt-get install -y --no-install-recommends ffmpeg \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY backend/requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY backend/ .

# Bring in the pre-built SPA from the frontend stage.
COPY --from=frontend-build /frontend/dist /frontend/dist

# Render injects $PORT at runtime; fall back to 8000 for local runs.
EXPOSE 8000
CMD ["sh", "-c", "uvicorn app.main:app --host 0.0.0.0 --port ${PORT:-8000}"]
