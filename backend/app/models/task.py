"""Internal task data model.

`AnalysisTask` is the in-memory + on-disk representation of one analysis job.
It is intentionally a plain dataclass (not a Pydantic model) so it can hold
non-serializable runtime fields and convert to the wire schemas on demand.
"""
from __future__ import annotations

import json
from dataclasses import dataclass, field
from typing import List, Optional

from ..schemas.analysis import AnalysisResult, Segment, TaskStatus


@dataclass
class AnalysisTask:
    task_id: str
    status: str = "queued"
    progress: int = 0
    error: Optional[str] = None
    video_name: str = ""
    video_path: Optional[str] = None
    wav_path: Optional[str] = None
    source_url: Optional[str] = None
    bpm: float = 0.0
    confidence: float = 0.0
    duration: float = 0.0
    beat_times: List[float] = field(default_factory=list)
    segments: List[Segment] = field(default_factory=list)
    created_at: str = ""
    beat_low_confidence: bool = False

    def to_status(self) -> TaskStatus:
        result = self.to_result() if self.status == "done" else None
        return TaskStatus(
            taskId=self.task_id,
            status=self.status,
            progress=self.progress,
            result=result,
            error=self.error,
        )

    def to_result(self) -> AnalysisResult:
        return AnalysisResult(
            taskId=self.task_id,
            videoName=self.video_name,
            bpm=self.bpm,
            confidence=self.confidence,
            duration=self.duration,
            createdAt=self.created_at,
            segments=self.segments,
            beatLowConfidence=self.beat_low_confidence,
        )

    def to_dict(self) -> dict:
        return {
            "task_id": self.task_id,
            "status": self.status,
            "progress": self.progress,
            "error": self.error,
            "video_name": self.video_name,
            "video_path": self.video_path,
            "wav_path": self.wav_path,
            "source_url": self.source_url,
            "bpm": self.bpm,
            "confidence": self.confidence,
            "duration": self.duration,
            "beat_times": self.beat_times,
            "segments": [s.model_dump() for s in self.segments],
            "created_at": self.created_at,
            "beat_low_confidence": self.beat_low_confidence,
        }

    @classmethod
    def from_dict(cls, data: dict) -> "AnalysisTask":
        return cls(
            task_id=data["task_id"],
            status=data.get("status", "queued"),
            progress=data.get("progress", 0),
            error=data.get("error"),
            video_name=data.get("video_name", ""),
            video_path=data.get("video_path"),
            wav_path=data.get("wav_path"),
            source_url=data.get("source_url"),
            bpm=data.get("bpm", 0.0),
            confidence=data.get("confidence", 0.0),
            duration=data.get("duration", 0.0),
            beat_times=list(data.get("beat_times", [])),
            segments=[Segment(**s) for s in data.get("segments", [])],
            created_at=data.get("created_at", ""),
            beat_low_confidence=data.get("beat_low_confidence", False),
        )
