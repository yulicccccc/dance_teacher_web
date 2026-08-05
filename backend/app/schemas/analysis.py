"""Pydantic schemas for the analysis domain (snake_case to match the wire JSON).

Field names intentionally mirror the shared contract in `docs/system_design.md`
§3 so front/back stay in lock-step without any casing conversion layer.
"""
from __future__ import annotations

from typing import List, Literal, Optional

from pydantic import BaseModel, Field


class Segment(BaseModel):
    """A single 8-beat (8-count) phrase of the dance."""

    index: int  # 1-based
    startTime: float  # seconds
    endTime: float  # seconds
    type: str = "dance"  # dance | intro | break (reserved for P1-2)
    beats: List[float] = Field(default_factory=list)  # length 8, per-beat timestamps (s)


class AnalysisResult(BaseModel):
    """Structured analysis payload returned when a task is done."""

    taskId: str
    videoName: str
    bpm: float
    confidence: float  # 0~1
    duration: float  # seconds
    createdAt: str  # ISO-8601
    segments: List[Segment] = Field(default_factory=list)
    beatLowConfidence: bool = False


class TaskStatus(BaseModel):
    """Polling view of a task: status + progress, result attached when done."""

    taskId: str
    status: str  # queued|extracting|beat_detecting|segmenting|done|failed
    progress: int  # 0~100
    result: Optional[AnalysisResult] = None
    error: Optional[str] = None


class UploadResponse(BaseModel):
    taskId: str
    status: str


class RecomputeRequest(BaseModel):
    """Body for the beat re-computation fallback."""

    # `fixedBpm` lets the user override the detected tempo with a value they
    # typed in; `bpm` is required (and range-checked 40-300) only for that mode.
    mode: Literal['auto', 'fixed120', 'fixedBpm', 'manual_first_beat']
    firstBeatTime: Optional[float] = None  # required when mode == manual_first_beat
    bpm: Optional[float] = None  # required when mode == fixedBpm


class ErrorResponse(BaseModel):
    """Uniform error envelope: { code, message, data }."""

    code: str
    message: str
    data: Optional[object] = None
