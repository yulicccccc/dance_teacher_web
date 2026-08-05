"""Fast-BPM recovery regression tests (T4).

Synthesizes stable kick/snare click tracks and asserts `detect()` reports the
*true* tempo for genuinely fast material (220 / 240 BPM — previously reported
at half speed, 110 / 120) while medium material (100 / 130 BPM) is left
untouched (never doubled to 200 / 260).

These cases guard the fix in `beat_detector.detect`: the low-band recovery
ceiling is now `RECOVER_CEIL_BPM = 260`, decoupled from `FAST_BEAT_BPM`, so the
recovery is allowed to fire for 220 / 240 while its low-band midpoint gate still
refuses to double genuine slow/medium tracks.
"""
from __future__ import annotations

import wave

import numpy as np
import pytest

from app.services import beat_detector as bd


def _make_kick_snare_wav(
    path: str,
    bpm: float,
    duration: float = 8.0,
    weak: float = 0.85,
    sr: int = 22050,
) -> None:
    """Kick on odd beats, snare (amplitude `weak`) on even beats.

    Mirrors the builder used by the main test suite so the fast tracks below
    are the same kind of material the app is built for: a steady kick/snare
    pulse whose half-tempo lattice used to fool the detector into reporting
    half speed.
    """
    rng = np.random.default_rng(11)
    n = int(duration * sr)
    y = np.zeros(n, dtype=np.float64)
    ln = int(0.18 * sr)
    t = np.arange(ln) / sr
    kick = np.sin(2 * np.pi * 60 * t) * np.exp(-t * 26) + np.exp(-t * 900) * 0.8
    snare = rng.standard_normal(ln) * np.exp(-t * 34)
    period = 60.0 / bpm
    k = 0
    while k * period < duration:
        i = int(k * period * sr)
        src = kick if k % 2 == 0 else snare * weak
        seg = src[: max(0, min(src.size, n - i))]
        if seg.size:
            y[i : i + seg.size] += seg
        k += 1
    y = y / (float(np.max(np.abs(y))) or 1.0) * 0.9
    with wave.open(path, "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(sr)
        w.writeframes((y * 32767).astype("<i2").tobytes())


@pytest.mark.skipif(
    __import__("importlib").util.find_spec("librosa") is None,
    reason="librosa not installed (no 3.13 wheel) — run on Python 3.10/3.11",
)
@pytest.mark.parametrize("bpm", [120.0, 176.0, 200.0, 220.0, 240.0])
def test_fast_genuine_tempo_is_recovered(tmp_path, bpm: float) -> None:
    """Genuinely fast tracks must be reported at their true tempo, not half.

    220 / 240 used to come back as 110 / 120 (half speed). A tolerance of
    ``abs(diff) <= 3`` cleanly separates the correct reading from the old
    half-speed bug (which would be off by ~110-130 BPM).
    """
    wav = tmp_path / f"fast_{int(bpm)}.wav"
    _make_kick_snare_wav(str(wav), bpm, 8.0, 0.9)
    out_bpm, _conf, beat_times, _dur = bd.detect(str(wav))

    # The core contract: reported BPM describes the emitted beats.
    assert len(beat_times) >= 4
    ibi = np.diff(np.asarray(beat_times, dtype=float))
    assert abs(60.0 / float(np.median(ibi)) - out_bpm) / out_bpm < 0.05

    assert abs(out_bpm - bpm) <= 3.0, (
        f"genuine {bpm:.0f} BPM reported as {out_bpm:.2f} — half-speed bug returned"
    )


@pytest.mark.skipif(
    __import__("importlib").util.find_spec("librosa") is None,
    reason="librosa not installed (no 3.13 wheel) — run on Python 3.10/3.11",
)
@pytest.mark.parametrize("bpm", [100.0, 130.0])
def test_medium_tempo_is_not_doubled(tmp_path, bpm: float) -> None:
    """Medium tracks must stay near their true tempo, never doubled to 2x.

    The higher `RECOVER_CEIL_BPM` lets the recovery *attempt* on a 100/130 BPM
    grid, but its low-band midpoint gate refuses (no hits between the beats), so
    the result must read ~100/130, not 200/260.
    """
    wav = tmp_path / f"med_{int(bpm)}.wav"
    _make_kick_snare_wav(str(wav), bpm, 8.0, 0.9)
    out_bpm, _conf, _beats, _dur = bd.detect(str(wav))

    assert out_bpm == pytest.approx(bpm, rel=0.05), (
        f"genuine {bpm:.0f} BPM reported as {out_bpm:.2f} — spurious doubling"
    )
    # Explicit guard against the 2x mistake: 100 must not read as 200, 130 not 260.
    assert out_bpm < bpm * 1.5
