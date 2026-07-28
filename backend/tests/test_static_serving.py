"""Regression tests for single-port production frontend serving.

Guards against the static-file path bug where ``main.py`` resolved
``backend/frontend/dist`` (a non-existent directory) instead of
``<project_root>/frontend/dist``. When the build output is present the backend
must mount it and serve ``index.html`` from ``/``.
"""
from __future__ import annotations

import os

import pytest
from fastapi.testclient import TestClient
from fastapi.routing import APIRoute

from app.main import _FRONTEND_DIST, app

client = TestClient(app)


@pytest.mark.skipif(
    not os.path.isdir(_FRONTEND_DIST),
    reason="frontend/dist not built; static serving is optional",
)
def test_frontend_dist_resolves_to_project_root():
    """The resolved static dir must be <project_root>/frontend/dist, not backend/..."""
    normalized = _FRONTEND_DIST.replace("\\", "/")
    assert normalized.endswith("/frontend/dist")
    # Regression check: it must NOT be nested under backend/.
    assert "/backend/frontend" not in normalized
    assert os.path.isfile(os.path.join(_FRONTEND_DIST, "index.html"))


@pytest.mark.skipif(
    not os.path.isdir(_FRONTEND_DIST),
    reason="frontend/dist not built; static serving is optional",
)
def test_root_serves_index_html():
    r = client.get("/")
    assert r.status_code == 200
    assert "text/html" in r.headers.get("content-type", "")
    body = r.text
    assert '<div id="root">' in body
    assert "舞蹈老师" in body


@pytest.mark.skipif(
    not os.path.isdir(_FRONTEND_DIST),
    reason="frontend/dist not built; static serving is optional",
)
def test_spa_catchall_registered():
    # The SPA fallback is registered as a catch-all GET route.
    assert any(
        isinstance(route, APIRoute) and route.path == "/{full_path:path}"
        for route in app.routes
    )


@pytest.mark.skipif(
    not os.path.isdir(_FRONTEND_DIST),
    reason="frontend/dist not built; static serving is optional",
)
def test_deep_client_route_serves_index_html():
    r = client.get("/analysis/some-task-id")
    assert r.status_code == 200
    assert "text/html" in r.headers.get("content-type", "")
    assert '<div id="root">' in r.text


@pytest.mark.skipif(
    not os.path.isdir(_FRONTEND_DIST),
    reason="frontend/dist not built; static serving is optional",
)
def test_unknown_api_path_returns_404():
    r = client.get("/api/v1/does-not-exist")
    assert r.status_code == 404


@pytest.mark.skipif(
    not os.path.isdir(_FRONTEND_DIST),
    reason="frontend/dist not built; static serving is optional",
)
def test_path_traversal_serves_spa_not_file():
    # A traversal attempt must NOT leak files outside the build dir.
    r = client.get("/../../etc/passwd")
    assert r.status_code == 200
    assert "text/html" in r.headers.get("content-type", "")
    assert "root:x:" not in r.text
