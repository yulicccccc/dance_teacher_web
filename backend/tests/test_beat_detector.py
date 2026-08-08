"""Tests for app.services.beat_detector.

`_effective_tempo` / `_confidence` only need numpy (installed in this sandbox)
and are tested directly. The full `detect()` path needs librosa + a real audio
file; that test is guarded by `importorskip` and will be SKIPPED here because
librosa has no prebuilt wheel for Python 3.13. Run it locally on Python 3.10/3.11
for real end-to-end validation (see the QA report).
"""
from __future__ import annotations

import wave

import numpy as np
import pytest

from app.services import beat_detector as bd


def test_effective_tempo_regular_grid():
    assert bd._effective_tempo([0.0, 0.5, 1.0, 1.5]) == pytest.approx(120.0)


def test_effective_tempo_single_beat_is_zero():
    assert bd._effective_tempo([0.0]) == 0.0
    assert bd._effective_tempo([]) == 0.0


def test_confidence_perfect_grid_is_one():
    beats = [round(i * 0.5, 4) for i in range(32)]
    assert bd._confidence(beats) == pytest.approx(1.0)


def test_confidence_wobbly_grid_is_low():
    beats = [0.0, 0.4, 1.3, 1.6, 2.8, 3.0, 4.5]  # irregular intervals
    conf = bd._confidence(beats)
    assert 0.0 <= conf < 1.0


def test_confidence_needs_at_least_three_beats():
    assert bd._confidence([0.0, 0.5]) == 0.0


def _make_click_wav(path: str, bpm: float = 120.0, duration: float = 8.0, sr: int = 16000):
    interval = 60.0 / bpm
    n = int(sr * duration)
    t = np.arange(n) / sr
    clicks = np.zeros(n, dtype=np.float32)
    for k in range(int(duration / interval) + 2):
        idx = int(k * interval * sr)
        if idx < n:
            clicks[idx] = 1.0
    tone = 0.05 * np.sin(2 * np.pi * 220.0 * t)
    signal = (np.clip(clicks * 0.8 + tone, -1.0, 1.0) * 32767).astype("<i2")
    with wave.open(path, "wb") as wf:
        wf.setnchannels(1)
        wf.setsampwidth(2)
        wf.setframerate(sr)
        wf.writeframes(signal.tobytes())


@pytest.mark.skipif(
    __import__("importlib").util.find_spec("librosa") is None,
    reason="librosa not installed (no 3.13 wheel) — run on Python 3.10/3.11",
)
def test_detect_real_click_track(tmp_path):
    wav = tmp_path / "click_120.wav"
    _make_click_wav(str(wav), bpm=120.0, duration=8.0)
    bpm, confidence, beat_times, duration = bd.detect(str(wav))
    assert 100.0 <= bpm <= 140.0
    assert len(beat_times) >= 8
    assert 7.0 <= duration <= 9.0


def _make_rubato_wav(path: str, onsets, sr: int = 16000):
    """Render a click track whose beats sit at the given (possibly non-uniform)
    onset times — used to verify Bug D (no cumulative drift on rubato audio)."""
    onsets = [float(o) for o in onsets]
    n = int(sr * (max(onsets) + 0.5)) + 1
    t = np.arange(n) / sr
    clicks = np.zeros(n, dtype=np.float32)
    for ot in onsets:
        idx = int(round(ot * sr))
        if 0 <= idx < n:
            clicks[idx] = 1.0
    tone = 0.05 * np.sin(2 * np.pi * 220.0 * t)
    signal = (np.clip(clicks * 0.8 + tone, -1.0, 1.0) * 32767).astype("<i2")
    with wave.open(path, "wb") as wf:
        wf.setnchannels(1)
        wf.setsampwidth(2)
        wf.setframerate(sr)
        wf.writeframes(signal.tobytes())


@pytest.mark.skipif(
    __import__("importlib").util.find_spec("librosa") is None,
    reason="librosa not installed (no 3.13 wheel) — run on Python 3.10/3.11",
)
def test_detect_no_cumulative_drift_rubato(tmp_path):
    """Bug D: beats must stay anchored to real onset peaks — no cumulative drift.

    Synthesize a ~120 BPM click track whose inter-beat interval wobbles by
    +/-8% frame to frame (tempo rubato). A single global `beat_track(start_bpm=120)`
    would lock one tempo and drift away on long audio. Our detector instead
    snaps every beat to the nearest onset peak within +/-0.06 s, so:

      * each detected beat_time is within 0.06 s of the nearest onset, and
      * that residual stays bounded along the whole track (no growing error),
        which is exactly what kills the "accurate at the start, off by the end"
        symptom.
    """
    rng = np.random.default_rng(7)
    base = 0.5  # 120 BPM -> 0.5 s/beat
    onsets: list[float] = [0.2]
    for _ in range(60):
        ibi = base * (1.0 + rng.uniform(-0.08, 0.08))
        onsets.append(onsets[-1] + ibi)
    onsets_arr = np.asarray(onsets, dtype=float)

    wav = tmp_path / "rubato.wav"
    _make_rubato_wav(str(wav), onsets)

    bpm, confidence, beat_times, duration = bd.detect(str(wav))
    beat_times_arr = np.asarray(beat_times, dtype=float)

    assert 90.0 <= bpm <= 160.0  # robust tempo, octave-corrected
    assert len(beat_times) >= 8

    SNAP = 0.06
    residuals = []
    for bt in beat_times_arr:
        nearest = onsets_arr[np.argmin(np.abs(onsets_arr - bt))]
        d = abs(nearest - bt)
        residuals.append(d)
        assert d <= SNAP, f"beat {bt:.4f} not snapped to an onset (nearest {nearest:.4f}, d={d:.4f})"

    # The residual is bounded by the snap window, so drift cannot accumulate:
    # a drifting grid would grow its error without bound, but ours stays <= SNAP.
    assert max(residuals) <= SNAP + 1e-9
    assert confidence >= 0.0  # sanity (rubato lowers it; not gated)
