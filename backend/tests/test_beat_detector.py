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


# --- Grid-path confidence ----------------------------------------------------
#
# `_confidence` is interval-CV based, so on the uniform-grid path — where the
# beats are perfectly even *by construction* — it is pinned at 1.0 and
# `beat_low_confidence` can never fire. `_grid_path_confidence` replaces it
# there with a measure of how well the grid explains the onset envelope.


def _synth_env(n=2000, period_frames=40, floor=0.0, peak=1.0, width=2):
    """Onset envelope with a spike every `period_frames` frames, plus a floor."""
    env = np.full(n, float(floor))
    for i in range(0, n, period_frames):
        env[i : i + width] += peak
    return env


def test_confidence_is_pinned_at_one_for_a_uniform_grid():
    """The reason `_grid_path_confidence` has to exist at all."""
    uniform = bd._build_grid(0.5, 0.0, 20.0, 20.0)
    assert len(uniform) > 3
    assert bd._confidence(uniform) == pytest.approx(1.0)


def test_onset_contrast_is_high_when_beats_land_on_peaks():
    sr, hop, period_frames = 22050, 128, 40
    env = _synth_env(period_frames=period_frames)
    period_s = period_frames * hop / sr
    beats = [i * period_s for i in range(2000 // period_frames)]
    assert bd._onset_contrast(env, sr, hop, beats) > 5.0


def test_onset_contrast_is_low_when_beats_miss_the_peaks():
    """Same envelope, grid shifted half a period off the peaks."""
    sr, hop, period_frames = 22050, 128, 40
    env = _synth_env(period_frames=period_frames)
    period_s = period_frames * hop / sr
    beats = [(i + 0.5) * period_s for i in range(2000 // period_frames - 1)]
    assert bd._onset_contrast(env, sr, hop, beats) < 1.0


def test_onset_contrast_survives_an_additive_noise_floor():
    """Regression: a loud background floor must not sink a correct grid.

    A noisy / reverberant mix adds a near-constant offset to every envelope
    frame. Without the percentile floor subtraction that offset dominates the
    denominator and drags the ratio toward 1.0, which measurably destroyed the
    separation between real music and beatless audio during calibration.
    """
    sr, hop, period_frames = 22050, 128, 40
    period_s = period_frames * hop / sr
    beats = [i * period_s for i in range(2000 // period_frames)]

    clean = bd._onset_contrast(_synth_env(period_frames=period_frames, floor=0.0), sr, hop, beats)
    washed = bd._onset_contrast(_synth_env(period_frames=period_frames, floor=3.0), sr, hop, beats)

    assert clean > 5.0
    # The floor is 3x the peak height, yet the contrast must barely move.
    assert washed == pytest.approx(clean, rel=0.10)


def test_onset_contrast_of_a_flat_envelope_is_zero():
    assert bd._onset_contrast(np.full(500, 0.7), 22050, 128, [0.0, 0.5, 1.0, 1.5]) == 0.0


def test_onset_contrast_needs_two_beats():
    assert bd._onset_contrast(_synth_env(), 22050, 128, [0.0]) == 0.0


def test_grid_path_confidence_is_high_for_a_grid_that_fits():
    sr, hop, period_frames = 22050, 128, 40
    env = _synth_env(period_frames=period_frames)
    period_s = period_frames * hop / sr
    beats = [i * period_s for i in range(2000 // period_frames)]
    assert bd._grid_path_confidence(env, sr, hop, beats) > 0.8


def test_grid_path_confidence_is_low_for_a_grid_that_does_not_fit():
    """A grid over an envelope it does not explain must drop below the flag."""
    from app.core.config import LOW_CONFIDENCE_THRESHOLD

    sr, hop = 22050, 128
    rng = np.random.default_rng(3)
    # Near-flat envelope: nothing for a grid to lock onto.
    env = 1.0 + 0.02 * rng.standard_normal(2000)
    beats = [i * (40 * hop / sr) for i in range(50)]
    conf = bd._grid_path_confidence(env, sr, hop, beats)
    assert conf < LOW_CONFIDENCE_THRESHOLD


def test_grid_path_confidence_is_clamped_to_unit_range():
    sr, hop = 22050, 128
    env = _synth_env(period_frames=40, peak=1000.0)
    beats = [i * (40 * hop / sr) for i in range(50)]
    assert 0.0 <= bd._grid_path_confidence(env, sr, hop, beats) <= 1.0


def test_grid_path_confidence_needs_at_least_three_beats():
    """Inherited from the `_confidence` factor, which zeroes degenerate grids."""
    assert bd._grid_path_confidence(_synth_env(), 22050, 128, [0.0, 0.5]) == 0.0


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


def _make_drone_wav(path: str, duration: float = 20.0, sr: int = 22050):
    """A steady harmonic drone: no transients, so no beat exists at all.

    It is nonetheless perfectly *stationary*, which is what makes the tracker
    emit a steady low-CV grid that clears the uniform-grid gate — i.e. exactly
    the situation where the old interval-CV confidence reported a confident 1.0
    for a completely meaningless grid.
    """
    t = np.arange(int(sr * duration)) / sr
    y = sum(0.25 * np.sin(2 * np.pi * f * t) for f in (110.0, 165.0, 220.0, 330.0))
    y = y / (np.max(np.abs(y)) + 1e-9) * 0.8
    signal = (np.clip(y, -1.0, 1.0) * 32767).astype("<i2")
    with wave.open(path, "wb") as wf:
        wf.setnchannels(1)
        wf.setsampwidth(2)
        wf.setframerate(sr)
        wf.writeframes(signal.tobytes())


@pytest.mark.skipif(
    __import__("importlib").util.find_spec("librosa") is None,
    reason="librosa not installed (no 3.13 wheel) — run on Python 3.10/3.11",
)
def test_detect_reports_high_confidence_on_musical_audio(tmp_path):
    """A grid that genuinely fits the music must stay well clear of the flag."""
    from app.core.config import LOW_CONFIDENCE_THRESHOLD

    wav = tmp_path / "click_120_long.wav"
    _make_click_wav(str(wav), bpm=120.0, duration=20.0, sr=22050)
    bpm, confidence, beat_times, duration = bd.detect(str(wav))

    assert 100.0 <= bpm <= 140.0
    assert confidence > 0.8
    assert confidence >= LOW_CONFIDENCE_THRESHOLD  # flag stays silent


@pytest.mark.skipif(
    __import__("importlib").util.find_spec("librosa") is None,
    reason="librosa not installed (no 3.13 wheel) — run on Python 3.10/3.11",
)
def test_detect_low_confidence_flag_fires_on_beatless_audio(tmp_path):
    """Regression: confidence must be able to reach the low-confidence flag.

    On the uniform-grid path confidence used to be `_confidence(beat_times)`.
    Since that grid is perfectly even by construction its interval CV is 0, so
    confidence was a hard-coded 1.0 and `beat_low_confidence` — the trigger for
    the frontend's "please recalibrate" prompt — could never fire, no matter how
    wrong the grid was. This drone has no beat whatsoever, so the reported
    confidence has to drop under the threshold.
    """
    from app.core.config import LOW_CONFIDENCE_THRESHOLD

    wav = tmp_path / "drone.wav"
    _make_drone_wav(str(wav), duration=20.0)
    bpm, confidence, beat_times, duration = bd.detect(str(wav))

    assert len(beat_times) >= 4  # the tracker did emit a (meaningless) grid
    assert confidence < LOW_CONFIDENCE_THRESHOLD, (
        f"beatless audio reported confidence {confidence:.3f}; the "
        f"beat_low_confidence flag would never fire"
    )


# --- Octave resolution: bpm and beat_times must never disagree ---------------
#
# `_octave_clamp` used to be applied to the reported *number* while the emitted
# grid kept the spacing the fitter found. A track whose grid sat at 64 BPM was
# therefore reported as "128 BPM" with 64 BPM beats, and every 8-count built
# from those beats spanned twice the intended music. Measured over 12 textures
# the old code broke the invariant on 3 of them, by exactly 50%.


def test_nearest_distance_matches_bruteforce():
    """`_nearest_distance` is a searchsorted optimisation — it must be exact."""
    rng = np.random.default_rng(3)
    a = np.sort(rng.uniform(0, 50, 200))
    b = np.sort(rng.uniform(0, 50, 90))
    expected = np.abs(a[:, None] - b[None, :]).min(axis=1)
    assert bd._nearest_distance(a, b) == pytest.approx(expected)


def test_nearest_distance_empty_reference_is_infinite():
    out = bd._nearest_distance(np.array([1.0, 2.0]), np.array([]))
    assert np.all(np.isinf(out))


def test_octave_fitness_prefers_the_true_beat_level():
    """The criterion must be neutral in beat density.

    `_comb_search`'s `sum(env)/sqrt(n)` is not: it rewards a half-tempo grid
    whenever the off-beat is weaker than `sqrt(2)-1` of the on-beat. The
    F-measure penalises *both* directions, so only the true level wins.
    """
    onsets = np.arange(0.0, 40.0, 0.5)          # a real 120 BPM pulse
    weights = np.ones(onsets.size)
    half = np.arange(0.0, 40.0, 1.0)            # 60 BPM  — misses half the music
    true = np.arange(0.0, 40.0, 0.5)            # 120 BPM — correct
    double = np.arange(0.0, 40.0, 0.25)         # 240 BPM — half of it lands on nothing

    f_half = bd._octave_fitness(onsets, weights, half, 0.05)
    f_true = bd._octave_fitness(onsets, weights, true, 0.05)
    f_double = bd._octave_fitness(onsets, weights, double, 0.05)

    assert f_true > f_half, "sparse grid must lose recall"
    assert f_true > f_double, "dense grid must lose precision"
    assert f_true == pytest.approx(1.0, abs=1e-6)


def test_octave_fitness_degenerate_inputs_are_zero():
    assert bd._octave_fitness(np.array([]), np.array([]), np.arange(10.0), 0.05) == 0.0
    assert bd._octave_fitness(np.arange(10.0), np.ones(10), np.array([1.0]), 0.05) == 0.0


def test_band_target_period_moves_the_period_not_the_number():
    # 64 BPM -> below SLOW(70) -> one doubling -> 128 BPM
    assert bd._band_target_period(60.0 / 64.0, 70.0, 200.0) == pytest.approx(60.0 / 128.0)
    # 240 BPM -> above FAST(200) -> one halving -> 120 BPM
    assert bd._band_target_period(60.0 / 240.0, 70.0, 200.0) == pytest.approx(60.0 / 120.0)
    # already inside the band -> untouched
    assert bd._band_target_period(0.5, 70.0, 200.0) == 0.5


def test_densify_and_sparsify_are_inverse_on_a_uniform_grid():
    beats = [i * 0.5 for i in range(9)]
    dense = bd._densify_beats(beats)
    assert len(dense) == 2 * len(beats) - 1
    assert bd._sparsify_beats(dense) == pytest.approx(beats)


def test_resolve_octave_refuses_to_invent_beats_that_are_not_there():
    """A genuine 64 BPM track must not be densified to 128 just to enter the band."""
    onsets = np.arange(0.0, 40.0, 60.0 / 64.0)      # events only at 64 BPM
    weights = np.ones(onsets.size)
    period = 60.0 / 64.0
    resolved = bd._resolve_octave(
        onsets, weights, period, 0.0, 40.0, 40.0, 70.0, 200.0
    )
    assert resolved == pytest.approx(period), "silence must not be relabelled as a beat"


def test_resolve_octave_accepts_a_move_the_audio_supports():
    """A real backbeat means the denser grid explains more — take it."""
    onsets = np.arange(0.0, 40.0, 60.0 / 128.0)     # events at the full 128 BPM
    weights = np.ones(onsets.size)
    half_period = 60.0 / 64.0                       # fitter locked the half grid
    resolved = bd._resolve_octave(
        onsets, weights, half_period, 0.0, 40.0, 40.0, 70.0, 200.0
    )
    assert resolved == pytest.approx(60.0 / 128.0)


def test_resolve_octave_beats_keeps_list_and_tempo_consistent():
    """Fallback path: the returned beats and their median tempo must agree."""
    onsets = np.arange(0.0, 40.0, 60.0 / 128.0)
    weights = np.ones(onsets.size)
    beats = [i * (60.0 / 64.0) for i in range(40)]  # half-tempo raw track
    out = bd._resolve_octave_beats(onsets, weights, beats, 70.0, 200.0)
    tempo = bd._effective_tempo_median(out)
    assert tempo == pytest.approx(128.0, rel=0.02)
    assert len(out) == 2 * len(beats) - 1


def _make_kick_snare_wav(path: str, bpm: float, duration: float = 20.0,
                         weak: float = 0.85, sr: int = 22050):
    """Kick on odd beats, snare (amplitude `weak`) on even beats.

    `weak=0.0` yields a track whose only real events are at *half* `bpm` — the
    material that used to be reported at double its true tempo.
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
@pytest.mark.parametrize(
    "name,builder",
    [
        # kick + snare: the 8-count material this app is built for
        ("kick_snare_128", lambda p: _make_kick_snare_wav(p, 128.0, 20.0, 0.85)),
        ("kick_snare_quiet", lambda p: _make_kick_snare_wav(p, 128.0, 20.0, 0.30)),
        # kicks only -> genuinely half that tempo; must not be densified
        ("true_slow_64", lambda p: _make_kick_snare_wav(p, 128.0, 20.0, 0.0)),
        ("true_slow_56", lambda p: _make_kick_snare_wav(p, 112.0, 20.0, 0.0)),
        # fast material must not be sparsified
        ("fast_176", lambda p: _make_kick_snare_wav(p, 176.0, 20.0, 0.9)),
        # pure click track
        ("click_120", lambda p: _make_click_wav(p, bpm=120.0, duration=20.0, sr=22050)),
        # tempo variation -> exercises the raw+snap fallback path
        ("rubato", lambda p: _make_rubato_wav(p, _rubato_onsets())),
    ],
)
def test_bpm_always_matches_the_emitted_beat_spacing(tmp_path, name, builder):
    """Core invariant: the reported BPM must describe the beats we return.

    Without it the number and the grid describe different tempos, and the
    8-count segmentation — the feature this whole service exists for — spans
    the wrong amount of music while the UI confidently shows a plausible BPM.
    """
    wav = tmp_path / f"{name}.wav"
    builder(str(wav))
    bpm, confidence, beat_times, duration = bd.detect(str(wav))

    assert len(beat_times) >= 4, f"{name}: too few beats to judge"
    ibi = np.diff(np.asarray(beat_times, dtype=float))
    grid_bpm = 60.0 / float(np.median(ibi))
    deviation = abs(grid_bpm - bpm) / bpm

    assert deviation < 0.05, (
        f"{name}: reported {bpm:.2f} BPM but the emitted grid is spaced at "
        f"{grid_bpm:.2f} BPM ({deviation * 100:.1f}% off) — an 8-count built "
        f"from these beats would span the wrong amount of music"
    )


def _rubato_onsets():
    rng = np.random.default_rng(7)
    onsets = [0.2]
    for _ in range(60):
        onsets.append(onsets[-1] + 0.5 * (1.0 + rng.uniform(-0.08, 0.08)))
    return onsets


@pytest.mark.skipif(
    __import__("importlib").util.find_spec("librosa") is None,
    reason="librosa not installed (no 3.13 wheel) — run on Python 3.10/3.11",
)
def test_detect_does_not_densify_genuinely_slow_material(tmp_path):
    """Reverse false-positive check for the octave gate.

    A 64 BPM track has *silence* between its beats. The band would like the
    number above SLOW_BEAT_BPM, but honouring that means inserting beats onto
    that silence, so the evidence gate has to refuse.
    """
    wav = tmp_path / "slow64.wav"
    _make_kick_snare_wav(str(wav), 128.0, duration=20.0, weak=0.0)
    bpm, confidence, beat_times, duration = bd.detect(str(wav))

    assert bpm == pytest.approx(64.0, rel=0.05), (
        f"reported {bpm:.2f}; a kicks-only 64 BPM track must not be doubled"
    )
    expected = int(duration / (60.0 / 64.0))
    assert abs(len(beat_times) - expected) <= 2, (
        f"emitted {len(beat_times)} beats, expected ~{expected} at 64 BPM"
    )


# --- Genuine-fast recovery (the last accuracy gap) --------------------------
#
# 176-240 BPM tracks (drum'n'bass, fast K-pop / EDM) were reported at ~half
# tempo. The global grid fit locks onto the half-tempo lattice (kick / snare
# on every *other* fast beat) and that grid wins grid-vs-raw arbitration, so
# `_resolve_octave` — which only acts on fits *outside* the tempo band — never
# sees a reason to move. `_recover_fast_period` / `_recover_fast_beats` close
# the gap with a low-band onset gate: genuine fast tracks have low-frequency
# (kick / snare) hits at every fast beat, including the half-tempo midpoints;
# slow tracks plus hi-hat subdivisions do not. These tests FAIL under the old
# behaviour (recovery removed -> 176 reports as 88 etc.), so they guard the fix.


def _make_kick_snare_hat_wav(path: str, bpm: float, duration: float = 20.0,
                             snare: float = 0.85, hat_gain: float = 0.5,
                             sr: int = 22050):
    """Kick / snare at `bpm` with an 8th-note hi-hat of pure high-frequency tone.

    The hi-hat is a 6 kHz tone: it carries *zero* energy below 250 Hz, so the
    low-band gate sees only the kick / snare on the slow beats. Doubling this is
    exactly the mistake a plain "is the denser grid better?" test makes (the
    subdiv grid scores 1.00 vs 0.72 for the true beat); the low-band gate must
    refuse and keep the true tempo.
    """
    rng = np.random.default_rng(11)
    n = int(duration * sr)
    y = np.zeros(n, dtype=np.float64)
    ln = int(0.18 * sr)
    t = np.arange(ln) / sr
    kick = np.sin(2 * np.pi * 60 * t) * np.exp(-t * 26) + np.exp(-t * 900) * 0.8
    snr = rng.standard_normal(ln) * np.exp(-t * 34)
    hln = int(0.05 * sr)
    ht = np.arange(hln) / sr
    hat = 0.5 * np.sin(2 * np.pi * 6000.0 * ht) * np.exp(-ht * 90.0)
    period = 60.0 / bpm
    k = 0
    while k * period < duration:
        i = int(k * period * sr)
        src = kick if k % 2 == 0 else snr * snare
        seg = src[: max(0, min(src.size, n - i))]
        if seg.size:
            y[i : i + seg.size] += seg
        for j in range(2):  # 8th-note hi-hat subdivision
            hi = int(round((k * period + j * period / 2.0) * sr))
            hseg = hat[: max(0, min(hat.size, n - hi))]
            if hseg.size:
                y[hi : hi + hseg.size] += hseg * hat_gain
        k += 1
    y = y / (float(np.max(np.abs(y))) or 1.0) * 0.9
    with wave.open(path, "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(sr)
        w.writeframes((np.clip(y, -1.0, 1.0) * 32767).astype("<i2").tobytes())


@pytest.mark.skipif(
    __import__("importlib").util.find_spec("librosa") is None,
    reason="librosa not installed (no 3.13 wheel) — run on Python 3.10/3.11",
)
@pytest.mark.parametrize(
    "bpm,snare",
    [
        (176.0, 0.9),
        (200.0, 0.9),
        (190.0, 0.9),
        (176.0, 0.55),  # quieter snare must still recover
    ],
)
def test_recover_genuine_fast_songs(tmp_path, bpm, snare):
    """A genuinely fast track must be reported at its true tempo, not half.

    This is the gap the low-band gate closes. With the recovery removed the
    same audio reports 88 / 100 / 95 BPM — the half-speed bug — so this test
    also fails on any revert and guards the fix.
    """
    wav = tmp_path / f"fast_{int(bpm)}_{snare}.wav"
    _make_kick_snare_wav(str(wav), bpm, 20.0, snare)
    out_bpm, _conf, beat_times, _dur = bd.detect(str(wav))

    assert out_bpm == pytest.approx(bpm, rel=0.05), (
        f"genuine {bpm:.0f} BPM reported as {out_bpm:.2f} — half-speed bug returned"
    )
    # the invariant must still hold: the reported number describes the grid
    ibi = np.diff(np.asarray(beat_times, dtype=float))
    assert abs(60.0 / float(np.median(ibi)) - out_bpm) / out_bpm < 0.05


@pytest.mark.skipif(
    __import__("importlib").util.find_spec("librosa") is None,
    reason="librosa not installed (no 3.13 wheel) — run on Python 3.10/3.11",
)
@pytest.mark.parametrize("bpm", [100.0, 128.0, 90.0])
def test_does_not_double_hihat_subdivisions(tmp_path, bpm):
    """8th-note hi-hat on a slow beat must NOT be read as a faster tempo.

    The F-measure approach doubles these; the low-band gate is blind to the
    hi-hat's high frequency and keeps the true tempo. Stays at `bpm`, never
    2 * `bpm`. This is the reverse false-positive guard.
    """
    wav = tmp_path / f"hat_{int(bpm)}.wav"
    _make_kick_snare_hat_wav(str(wav), bpm, 20.0, 0.85, 0.5)
    out_bpm, _conf, _beats, _dur = bd.detect(str(wav))

    assert out_bpm == pytest.approx(bpm, rel=0.05), (
        f"kick/snare@{bpm:.0f} + 8th hi-hat reported as {out_bpm:.2f} "
        f"— hi-hat trap fired"
    )


def test_recover_fast_period_gate_recovers_only_on_lowband_midpoints():
    """Unit test of the gate MECHANISM behind the genuine-fast recovery.

    Builds a synthetic low-band flux envelope (one value per STFT frame) with
    spikes placed exactly where `_recover_fast_period` probes — on the on-beats
    and, in the fast case, on the midpoints too. With midpoints hot the period
    must halve; with midpoints silent it must not move. This proves the gate,
    not a coincidence, is what stops the doubling (and what admits the fast one).
    """
    sr, hop = 22050, 128
    period = 60.0 / 88.0            # fitted half-tempo grid of a ~176 BPM track
    phase, t_hi, duration = 0.0, 20.0, 20.0
    on_times = bd._build_grid(period, phase, t_hi, duration)
    mid_times = bd._build_grid(period, phase + period / 2.0, t_hi, duration)
    n_frames = int(duration * sr / hop) + 4

    def make_env(with_midpoints: bool) -> np.ndarray:
        env = np.full(n_frames, 0.02)  # quiet low-band background
        def put(t, amp):
            fr = int(round(t * sr / hop))  # env frame = t * sr / hop
            if 0 <= fr < n_frames:
                env[fr] = amp
        for t in on_times:
            put(t, 1.0)
        if with_midpoints:
            for t in mid_times:
                put(t, 1.0)
        return env

    fast_env = make_env(with_midpoints=True)
    recovered = bd._recover_fast_period(
        lambda: fast_env, sr, hop, period, phase, t_hi, duration, 200.0
    )
    assert recovered == pytest.approx(period / 2.0), (
        "midpoints carry low-band hits -> fast track must be recovered"
    )

    slow_env = make_env(with_midpoints=False)
    kept = bd._recover_fast_period(
        lambda: slow_env, sr, hop, period, phase, t_hi, duration, 200.0
    )
    assert kept == pytest.approx(period), (
        "midpoints silent -> slow track must not be doubled"
    )
