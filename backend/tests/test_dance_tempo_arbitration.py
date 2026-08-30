"""Regression tests for competing rhythmic layers in dance music.

The real failure that motivated these tests was Tyla - THAT GIRL: the default
120 BPM prior followed a dense ~126 BPM percussion layer, while a second track
found the stable ~178 BPM pulse.  For dance practice that ambiguous fast pulse
is counted at half time (~89 BPM).

These tests model the arbitration itself with timestamp grids.  They contain
no copyrighted/user audio and run without invoking librosa's JIT-heavy audio
front end.
"""
from __future__ import annotations

import numpy as np
import pytest

from app.services import beat_detector as bd


def _grid(bpm: float, duration: float = 16.0, phase: float = 0.1) -> np.ndarray:
    return np.arange(phase, duration, 60.0 / bpm, dtype=float)


def _envelope(times: np.ndarray, duration: float = 16.0, sr: int = 100, hop: int = 1):
    env = np.zeros(int(duration * sr / hop) + 2, dtype=float)
    for time in times:
        frame = int(round(time * sr / hop))
        if 0 <= frame < env.size:
            env[frame] += 1.0
    return env, sr, hop


def test_competing_non_octave_layer_uses_half_time_dance_pulse() -> None:
    """A shaky 126 layer must not beat a stable 178/89 dance pulse."""
    rng = np.random.default_rng(29)
    primary = _grid(126.0) + rng.normal(0.0, 0.025, _grid(126.0).size)
    fast = _grid(178.0)

    # Both layers exist in the mix.  The fast lattice is steadier, but only
    # modestly stronger than the competing percussion, so dance counting uses
    # every other fast pulse (~89 BPM).
    onsets = np.sort(np.concatenate([fast, primary]))
    weights = np.concatenate(
        [np.ones(fast.size, dtype=float), np.full(primary.size, 0.72, dtype=float)]
    )[np.argsort(np.concatenate([fast, primary]))]
    env, sr, hop = _envelope(onsets)

    chosen, folded = bd._select_dance_tracker(
        primary.tolist(), fast.tolist(), onsets, weights, env, sr, hop
    )

    assert folded is True
    assert bd._effective_tempo_median(chosen) == pytest.approx(89.0, rel=0.02)


def test_clear_octave_fast_pulse_stays_fast() -> None:
    """A genuine fast pulse with a half-tempo tracker is not folded again."""
    fast = _grid(176.0)
    primary_half = fast[::2]
    env, sr, hop = _envelope(fast)

    chosen, folded = bd._select_dance_tracker(
        primary_half.tolist(),
        fast.tolist(),
        fast,
        np.ones(fast.size, dtype=float),
        env,
        sr,
        hop,
    )

    assert folded is False
    assert bd._effective_tempo_median(chosen) == pytest.approx(176.0, rel=0.02)


def test_spurious_fast_candidate_does_not_replace_medium_tempo() -> None:
    """A clean 120 BPM song must stay at 120 when a 180 candidate is noise."""
    primary = _grid(120.0)
    alternate = _grid(180.0, phase=0.23)
    env, sr, hop = _envelope(primary)

    chosen, folded = bd._select_dance_tracker(
        primary.tolist(),
        alternate.tolist(),
        primary,
        np.ones(primary.size, dtype=float),
        env,
        sr,
        hop,
    )

    assert folded is False
    assert bd._effective_tempo_median(chosen) == pytest.approx(120.0, rel=0.02)
