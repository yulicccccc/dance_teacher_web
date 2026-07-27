"""Tests for app.services.segmenter (8-beat aggregation + fallback grids)."""
from __future__ import annotations

import math

from app.services import segmenter
from app.services.segmenter import (
    aggregate,
    generate_fixed_beats,
    generate_from_first_beat,
)


def test_aggregate_120bpm_8s_produces_two_segments():
    """16 beats @ 0.5s interval over an 8s clip -> 2 segments of 8 beats each."""
    beats = [round(i * 0.5, 4) for i in range(16)]  # 0.0 .. 7.5
    duration = 8.0
    segs = aggregate(beats, duration)

    assert len(segs) == 2
    # segment 1
    assert segs[0].index == 1
    assert segs[0].startTime == 0.0
    assert segs[0].endTime == 4.0
    assert segs[0].type == "dance"
    assert len(segs[0].beats) == 8
    assert segs[0].beats == [0.0, 0.5, 1.0, 1.5, 2.0, 2.5, 3.0, 3.5]
    # segment 2
    assert segs[1].index == 2
    assert segs[1].startTime == 4.0
    assert segs[1].type == "dance"
    assert len(segs[1].beats) == 8
    assert segs[1].beats == [4.0, 4.5, 5.0, 5.5, 6.0, 6.5, 7.0, 7.5]
    # Last phrase extends by 0.5*avg_interval beyond the final beat (design §1.2).
    # Final beat = 7.5, avg interval = 0.5 -> 7.5 + 0.25 = 7.75, clamped to duration 8.0.
    assert math.isclose(segs[1].endTime, 7.75, abs_tol=1e-6)


def test_aggregate_index_starts_at_one_and_increments():
    beats = [round(i * 0.25, 4) for i in range(24)]  # 3 segments
    segs = aggregate(beats, 6.0)
    assert [s.index for s in segs] == [1, 2, 3]


def test_aggregate_drops_short_tail():
    """10 beats -> only the first full 8-count phrase is kept; the 2-beat tail is dropped."""
    beats = [round(i * 0.5, 4) for i in range(10)]
    segs = aggregate(beats, 5.0)
    assert len(segs) == 1
    assert len(segs[0].beats) == 8


def test_aggregate_fewer_than_8_beats_returns_empty():
    assert aggregate([0.1, 0.2, 0.3], 1.0) == []
    assert aggregate([], 8.0) == []


def test_aggregate_exactly_8_beats_single_segment():
    # Exactly 8 beats (0.0 .. 3.5) with duration 4.0. Because there is no 9th
    # beat, this is treated as the final phrase and extended by 0.5*avg_interval
    # (design §1.2): last beat 3.5 + 0.25 = 3.75, clamped to duration 4.0 -> 3.75.
    beats = [round(i * 0.5, 4) for i in range(8)]
    segs = aggregate(beats, 4.0)
    assert len(segs) == 1
    assert segs[0].startTime == 0.0
    assert segs[0].endTime == 3.75


def test_generate_fixed_beats_regular_grid():
    beats = generate_fixed_beats(8.0, 120.0)
    assert beats[0] == 0.0
    # 120 BPM -> 0.5s interval; inclusive of duration -> 0,0.5,...,8.0 == 17 beats
    assert beats == [round(i * 0.5, 4) for i in range(17)]
    assert beats[-1] == 8.0
    intervals = [beats[i + 1] - beats[i] for i in range(len(beats) - 1)]
    assert all(math.isclose(iv, 0.5, abs_tol=1e-6) for iv in intervals)


def test_generate_fixed_beats_interval_scales_with_bpm():
    beats = generate_fixed_beats(4.0, 60.0)
    assert all(math.isclose(b - a, 1.0, abs_tol=1e-6) for a, b in zip(beats, beats[1:]))


def test_generate_from_first_beat_anchors_start():
    beats = generate_from_first_beat(1.0, 120.0, 8.0)
    assert beats[0] == 1.0
    assert beats[-1] == 8.0
    assert all(math.isclose(b - a, 0.5, abs_tol=1e-6) for a, b in zip(beats, beats[1:]))


def test_generate_fixed_then_aggregate_two_segments():
    beats = generate_fixed_beats(8.0, 120.0)
    segs = aggregate(beats, 8.0)
    assert len(segs) == 2
    assert segs[0].endTime == 4.0
    assert segs[1].endTime == 8.0  # last beat == duration -> clean round end
    assert all(len(s.beats) == 8 for s in segs)
