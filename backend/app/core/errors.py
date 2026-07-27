"""Application-level error type and handler.

Produces the uniform error envelope ``{code, message, data}`` defined in
``docs/system_design.md`` §3/§7 instead of FastAPI's default ``{"detail": ...}``
wrapper. Routers raise ``AppError``; ``app_error_handler`` serialises it so the
frontend ``extractApiError`` (which reads ``response.data.code``) keeps working.
"""
from __future__ import annotations

from typing import Optional

from fastapi import Request
from fastapi.responses import JSONResponse

from ..schemas.analysis import ErrorResponse


class AppError(Exception):
    """Raise in routers to emit a top-level ``{code, message, data}`` body."""

    def __init__(
        self,
        code: str,
        message: str,
        status_code: int = 400,
        data: Optional[object] = None,
    ) -> None:
        super().__init__(message)
        self.code = code
        self.message = message
        self.status_code = status_code
        self.data = data


async def app_error_handler(request: Request, exc: AppError) -> JSONResponse:
    """Render an ``AppError`` as a top-level ``{code, message, data}`` JSON body."""
    return JSONResponse(
        status_code=exc.status_code,
        content=ErrorResponse(
            code=exc.code, message=exc.message, data=exc.data
        ).model_dump(),
    )
