"""Aggregate per-beat timestamps into 8-beat (8-count) dance phrases."""
from __future__ import annotations

from typing import List

from ..schemas.analysis import Segment


def _avg_interval(beats: List[float]) -> float:
    if len(beats) < 2:
        return 0.5
    total = 0.0
    for i in range(1, len(beats)):
        total += beats[i] - beats[i - 1]
    return total / (len(beats) - 1)


def aggregate(beat_times: List[float], duration: float, beats_per_segment: int = 8) -> List[Segment]:
    """Group beats into contiguous 8-beat segments.

    segment[i].startTime = beat_times[8i]
    segment[i].endTime   = beat_times[8i+8]  (last segment extends by 0.5 * avg interval)
    segment[i].beats     = beat_times[8i : 8i+8]   (fixed length 8)
    index starts at 1; type defaults to "dance".
    """
    # A beat exactly at the media duration is an end boundary, not the start of
    # a playable one-beat phrase. Drop it before grouping to avoid zero-length
    # final segments in fixed-BPM/manual grids.
    if duration and duration > 0:
        beat_times = [beat for beat in beat_times if float(beat) < duration - 1e-9]

    segments: List[Segment] = []
    n = len(beat_times)
    if n == 0:
        return segments

    index = 1
    i = 0
    # Keep walking the timeline. A trailing phrase with fewer than 8 beats is
    # still emitted (extended to the media end) rather than dropped — a
    # non-8-multiple beat count (e.g. manual_first_beat grids) must NOT lose the
    # final phrase. This is why "8 phrases in the video" used to show as 7.
    while i < n:
        seg_beats = beat_times[i : i + beats_per_segment]
        if not seg_beats:
            break
        # The first phrase owns any silent/no-beat pre-roll so the lesson never
        # starts several seconds into the video.
        start = 0.0 if i == 0 and duration > 0 else float(seg_beats[0])
        if i + beats_per_segment < n:
            end = float(beat_times[i + beats_per_segment])
        else:
            # The final phrase owns every remaining frame through media end.
            # Falling back to half an interval is only for callers without a
            # known duration.
            if duration and duration > 0:
                end = float(duration)
            else:
                avg = _avg_interval(seg_beats)
                end = float(seg_beats[-1]) + 0.5 * avg
        segments.append(
            Segment(
                index=index,
                startTime=start,
                endTime=end,
                type="dance",
                beats=[float(b) for b in seg_beats],
            )
        )
        i += beats_per_segment
        index += 1
    return segments


def generate_fixed_beats(duration: float, bpm: float = 120.0, beats_per_segment: int = 8) -> List[float]:
    """Build a perfectly regular beat grid (used by the fixed-BPM fallback)."""
    interval = 60.0 / bpm
    beats: List[float] = []
    t = 0.0
    while t <= duration:
        beats.append(round(t, 4))
        t += interval
    return beats


def generate_from_first_beat(
    first_beat_time: float, bpm: float, duration: float, beats_per_segment: int = 8
) -> List[float]:
    """Build a beat grid anchored on a user-supplied first beat (manual mode)."""
    interval = 60.0 / bpm
    beats: List[float] = []
    t = first_beat_time
    while t <= duration:
        beats.append(round(t, 4))
        t += interval
    return beats
