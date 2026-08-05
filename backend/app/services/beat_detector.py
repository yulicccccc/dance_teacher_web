"""BPM / beat detection built on librosa.

librosa and numpy are imported lazily inside the functions so the web app (and
`GET /health`) can boot even on machines where those heavy native deps are not
yet installed; only an actual analysis invocation will surface a clear error.
"""
from __future__ import annotations

import math
import threading
from typing import Callable, List, Optional, Tuple

# --- Analysis front-end constants -------------------------------------------
# These are *algorithm-internal* tuning knobs (deliberately NOT in core.config,
# which only holds product-level limits).
#
# ANALYSIS_SR = 22050 instead of the previous 16000. This is an *accuracy*
# change, not a speed one: analysing a real 43 s track at 16 kHz placed beats a
# median 41.1 ms from the nearest onset with a mean onset strength of 0.528,
# versus 17.4 ms / 1.210 at 22050 Hz. 16 kHz was systematically pulling beats
# off the real musical events.
#
# 22050 also divides 44.1 kHz exactly, so a 44.1 kHz source decimates without
# running a resampling filter. `audio_extractor` now writes 22050 Hz directly
# (see TARGET_SR there) so the common path does no rate conversion at all;
# 16 kHz WAVs from older builds still load fine, just upsampled (~0.15 s).
ANALYSIS_SR = 22050

# Hop used for beat *tracking*. 256 frames @ 22050 Hz = 11.6 ms per frame.
# Benchmarked against the real track: hop=512 degrades the tempo estimate
# (99.38 vs 101.33 BPM), hop=128 costs 4.5x more time in beat_track for no
# accuracy gain. 256 is the sweet spot.
HOP_TRACK = 256

# Hop used for the *fine* onset envelope that drives grid fitting, snapping and
# scoring. 128 frames = 5.8 ms per frame, i.e. sub-frame beat placement once
# combined with linear interpolation (see `_env_value_at`).
HOP_FINE = 128

# Adaptive arbitration between the raw tracked grid and the fitted uniform
# grid. `use_grid` requires the uniform grid to explain at least
# GRID_SCORE_TOL of the raw grid's onset energy AND the raw grid to be steady
# enough (CV <= GRID_MAX_CV) that a single global tempo is plausible.
# A 12-point threshold sweep (TOL in {0.80..0.95} x CVMAX in {0.10..0.25}) over
# 9 scenarios (constant tempo, jittered, ramping, tempo-jump medleys and the
# real track) produced zero misclassifications for every combination; 0.90 /
# 0.15 sits in the middle of that plateau.
GRID_SCORE_TOL = 0.90
GRID_MAX_CV = 0.15

# Max distance (seconds) a beat may be moved to land on an onset peak.
SNAP_WINDOW = 0.06

# --- Grid-path confidence ----------------------------------------------------
#
# On the grid path the emitted beats are perfectly even **by construction**, so
# the interval-CV measure `_confidence` returns exactly 1.0 for every track and
# `beat_low_confidence` (confidence < LOW_CONFIDENCE_THRESHOLD) could never
# fire — the "low confidence, please recalibrate" prompt was dead for every
# grid-path analysis, precisely the case where a wrong grid is most misleading
# (it *looks* immaculate because it is perfectly even). We therefore score the
# grid by **onset contrast**: how far above the background the onset envelope
# sits at the beats (see `_onset_contrast`).
#
# Percentile of the onset envelope treated as the background floor, subtracted
# before the contrast ratio is taken. This is not cosmetic — it is what makes
# the metric work. A noisy or heavily reverberant mix adds a large *additive*
# floor to the envelope, which drags the plain mean(at beats)/mean ratio toward
# 1.0 even when the grid is provably correct. Measured over a 21-texture
# battery, the un-subtracted ratio put correctly-locked music down at 2.09 and
# beatless material up at 2.00 — i.e. the two classes overlap and no threshold
# exists. Subtracting the floor first restores a clean 1.77x gap (worst music
# 5.00, best beatless 2.82). A percentile sweep (p in {0,10,...,60}) peaked at
# p=30 and was flat across p=20..40, so 30 sits in the middle of the plateau.
GRID_CONF_FLOOR_PCT = 30.0

# Contrast at which the grid counts as a *full* musical fit (quality 1.0);
# contrast 1.0 ("the grid explains nothing beyond the background") maps to 0.0.
#
# With GRID_CONF_FLOOR_PCT = 30 the measured classes are:
#   music, tempo correctly locked   5.00 .. 27.34   (worst: beat buried under a
#                                                    55% noisy-reverb wash then
#                                                    brick-wall limited)
#   beatless (no beat exists)       2.01 ..  2.82   (worst: speech-like babble)
# Requiring conf > 0.8 for music and conf < 0.6 for beatless bounds this
# constant to (4.03, 5.99); 5.0 is the geometric centre, leaving a 1.19x margin
# on the music side and 1.21x on the beatless side.
GRID_CONF_FULL_CONTRAST = 5.0

# --- Octave resolution -------------------------------------------------------
#
# The tempo band [SLOW_BEAT_BPM, FAST_BEAT_BPM] used to be enforced by
# `_octave_clamp`, which doubles/halves the reported *number* — and nothing
# else. The emitted `beat_times` kept the spacing the fitter found, so a track
# whose grid sat at 64 BPM was reported as "128 BPM" while shipping a 64 BPM
# grid: every downstream 8-count spanned twice the intended music. Measured
# over a 34-texture battery this fired on 15 of them, and in *every* case the
# fitted grid was self-consistent — the number alone was wrong.
#
# The band is now applied to the **period**, and the grid is rebuilt at that
# period, so `bpm` and `beat_times` can no longer disagree (see
# `_resolve_octave` / `_resolve_octave_beats`). Because that turns a cosmetic
# relabelling into a real change of the emitted beats, the move is gated on
# evidence: it is only accepted if the moved grid still explains the audio.
#
# Matching tolerance (seconds) between a grid point and a detected onset.
# 70 ms is the MIREX beat-tracking convention; it is additionally capped at
# 20% of the shortest candidate period so the tolerance windows of a dense
# candidate can never overlap (which would make precision meaningless).
OCTAVE_TOL = 0.07

# How much onset-explaining power a band-driven octave move may cost before it
# is refused. The criterion is a strength-weighted onset F-measure
# (`_octave_fitness`): a too-sparse grid loses recall, a too-dense grid loses
# precision, so unlike `_comb_search`'s `sum/sqrt(n)` score it is *neutral in
# beat density* — the sqrt(n) normalisation is exactly the bias that makes a
# half-tempo grid look good, so it must not be reused here.
#
# Calibrated by sweeping margin in {0.00..0.50} over a 16-texture battery
# (weak/strong backbeats, 8th-note hi-hats, genuine 56-64 BPM ballads, 176-240
# BPM DnB, plus noise and reverb variants). Every margin in [0.00, 0.32]
# classified all 16 correctly; above 0.35 genuine slow material starts being
# densified. 0.15 sits just under the midpoint of that plateau.
OCTAVE_F_MARGIN = 0.15


# --- Genuine-fast recovery (low-band evidence) -------------------------------
#
# `_resolve_octave` only ever fires when the fitted tempo is *outside*
# [SLOW_BEAT_BPM, FAST_BEAT_BPM]. A genuinely fast track — 176-240 BPM
# drum'n'bass, fast K-pop/EDM — is therefore left at half tempo: the global
# uniform-grid fit locks onto the half-tempo lattice (the kick/snare accents
# land on every *other* fast beat), 88 BPM is comfortably inside the band, so
# nothing asks for a move and no octave resolution is invoked. The result is
# self-consistent (`bpm` and `beat_times` agree) but musically half speed;
# measured over the texture battery this hit 176/190/200 BPM material 5/5.
#
# The obvious fix — densify whenever the denser grid scores better — is
# provably unsafe with `_octave_fitness`: on 8th-note hi-hat material the
# subdivision grid scores 1.00 against 0.72 for the true beat, so an
# evidence-only rule sends every hi-hat-heavy 90-110 BPM track to double
# tempo. That texture dominates this app's material, so that direction is
# closed.
#
# What separates the two cases is *where the energy lives*. Kick and snare sit
# in the low band; hi-hats and other subdivision ornaments do not. On a
# genuinely fast track every fast beat — including the midpoints of the
# half-tempo fit — carries a real low-frequency drum hit. On a slow track with
# a busy hi-hat those midpoints are empty down there. So the recovery is gated
# on a *low-band* onset envelope (`_lowband_onset_env`) rather than the
# full-band one used everywhere else.
#
# Band edges. 30-250 Hz spans the kick fundamental (~40-100 Hz) and the snare
# shell (~180-250 Hz) while excluding hi-hats (5 kHz+). An fmax sweep over
# {100, 120, 150, 200, 250, 300} was flat from 200 up; 250 is the middle of
# that plateau and the conventional kick+snare band.
LOW_BAND_FMIN = 30.0
LOW_BAND_FMAX = 250.0

# STFT size for the low-band envelope. 1024 @ 22050 Hz = 21.5 Hz bins (~11 bins
# inside the band) and a 46 ms window — short enough to resolve 240 BPM
# midpoints (125 ms apart). n_fft=2048 measurably blurred the separation
# (2.63x -> 1.17x) because its 93 ms window smears adjacent fast beats
# together; n_fft=512 was equivalent to 1024, so 1024 is the safe middle.
LOW_BAND_N_FFT = 1024

# Number of probes across the +/-tol window used to read the low-band peak.
# The envelope is a one-frame spike, so reading it *at* the grid time alone is
# not viable: with direct interpolation the measured evidence for genuinely
# fast material collapsed to 0.000 (the grid phase misses the spike by a
# frame). Sampling the window and taking the max fixes that; 9 probes cover a
# +/-34 ms window at ~8 ms spacing, i.e. finer than the 11.6 ms frame.
LOW_BAND_PROBES = 9

# Percentile of the on-beat low-band levels used as the reference. The *mean*
# is the wrong reference: on an alternating kick/snare pattern half the
# on-beats are snares, which are weak down here, so the mean is dragged down
# and a weak off-beat ornament looks stronger than it is. Normalising by the
# strong beats instead widened the measured separation from 1.63x to 2.62x.
LOW_BAND_ON_PCT = 75.0

# Condition 1 (relative): the inserted midpoints must carry at least this
# fraction of the low-band punch of the grid's *strong* beats. This is what
# refuses off-beat ornaments — a staccato 8th-note bassline or a ghost kick is
# real low-frequency energy, but it is not a beat.
#
# Measured over a 30-texture battery (see the module tests):
#   genuinely fast, must densify     0.857 .. 11.604
#   must NOT densify (ornaments)     0.042 ..  0.328
# Every threshold in (0.328, 0.857) classifies all 30 correctly. 0.55 sits
# essentially at the geometric centre (0.53) of that plateau, nudged up a
# touch because a false densification (a slow track reported at double tempo)
# is worse for an 8-count than leaving a fast track where it already is.
LOW_MID_RATIO = 0.55

# Condition 2 (absolute): the midpoint low-band level must stand this far above
# the track's mean low-band flux. Condition 1 alone is *not* sufficient and
# this is not belt-and-braces: on beatless material (a drone, white noise) both
# levels are just background, so their ratio is ~1.0 and condition 1 passes by
# accident — measured 0.855 / 0.906 / 0.899, i.e. above LOW_MID_RATIO. The
# absolute term separates them cleanly:
#   genuinely fast    15.58 .. 36.26
#   beatless           2.33 ..  3.81
# Every threshold in (3.81, 15.58) works; 8.0 is the geometric centre.
LOW_MID_CONTRAST = 8.0

# How far past FAST_BEAT_BPM the *doubled* tempo may land and still be
# recovered. Without any slack the rule has a cliff exactly at the band edge:
# a true 200 BPM track fits at 99.9994 BPM, so the doubled tempo is 199.9988 —
# inside by 0.0012 BPM, i.e. entirely at the mercy of fit noise. 2% removes
# that cliff. It cannot cause an octave misclassification because the
# neighbouring octave is 100% away, not 2%.
OCTAVE_BAND_SLACK = 0.02

# --- Genuine-fast recovery ceiling (decoupled from FAST_BEAT_BPM) ------------
#
# `_recover_fast_period` / `_recover_fast_beats` may only *halve* a grid, so the
# only thing their guard must rule out is the doubled tempo walking *above* some
# ceiling. That ceiling used to be `FAST_BEAT_BPM` (200) — which is correct for
# the band-driven `_resolve_octave`, but wrong here: a genuinely 220/240 BPM
# track fitted at half tempo has a doubled tempo of 220/240, comfortably under
# the band edge + slack was *not* guaranteed, so the recovery was refused and
# the track reported at half speed.
#
# We therefore give the recovery its own, higher ceiling (260) that is entirely
# independent of `FAST_BEAT_BPM`. `_resolve_octave`'s band and the fast-recovery
# ceiling are two different jobs and must not share a number: changing one must
# never silently change the other. The recovery is still gated by low-band
# evidence (`_midpoints_are_beats`), so the higher ceiling cannot double a
# genuine slow/medium track — it only lets the *fast* ones through.
RECOVER_CEIL_BPM = 260


def _as_float(v) -> float:
    """Coerce a scalar / 0-d / 1-d numpy tempo estimate to a plain float.

    librosa >= 0.11 returns an array from beat_track, older versions a scalar.
    """
    import numpy as np

    return float(np.asarray(v).ravel()[0])


def _effective_tempo(beat_times: List[float]) -> float:
    """Tempo inferred from the mean inter-beat interval (handles octave drift)."""
    if len(beat_times) < 2:
        return 0.0
    import numpy as np

    ibi = np.diff(np.asarray(beat_times, dtype=float))
    mean = float(np.mean(ibi))
    return 60.0 / mean if mean > 0 else 0.0


def _effective_tempo_median(beat_times: List[float]) -> float:
    """Tempo inferred from the *median* inter-beat interval.

    The median resists local jitter / outliers far better than the mean, which
    is why Bug-D uses it for the reported BPM (see `detect`).
    """
    if len(beat_times) < 2:
        return 0.0
    import numpy as np

    ibi = np.diff(np.asarray(beat_times, dtype=float))
    med = float(np.median(ibi))
    return 60.0 / med if med > 0 else 0.0


def _confidence(beat_times: List[float]) -> float:
    """Beat-grid confidence from inter-beat interval stability.

    Uses the coefficient of variation (CV) of the inter-beat intervals: a rock
    -solid grid has CV ~ 0 -> confidence 1, while a wobbly grid (CV >= 0.5) -> 0.
    """
    if len(beat_times) < 3:
        return 0.0
    import numpy as np

    ibi = np.diff(np.asarray(beat_times, dtype=float))
    mean = float(np.mean(ibi))
    if mean <= 0:
        return 0.0
    cv = float(np.std(ibi)) / mean
    return float(max(0.0, min(1.0, 1.0 - cv / 0.5)))


def _interval_cv(beat_times) -> float:
    """Coefficient of variation of the inter-beat intervals.

    Returns 1.0 (i.e. "totally unsteady") when there are too few beats to
    judge, so callers can safely use it as a gate.
    """
    import numpy as np

    b = np.asarray(beat_times, dtype=float)
    if b.size < 3:
        return 1.0
    ibi = np.diff(b)
    mean = float(np.mean(ibi))
    if mean <= 0:
        return 1.0
    return float(np.std(ibi) / mean)


def _octave_clamp(tempo: float, slow: float, fast: float) -> float:
    """Push a tempo estimate into [slow, fast] by octave doubling/halving.

    A locked-on tempo is musically correct; only the *number* may be off by a
    power of two (librosa sometimes reports half/double tempo).

    Only valid where there is **no beat grid to contradict** — i.e. the
    degenerate branch of `detect` that has fewer than two beats and therefore
    reports a bare tempo. Everywhere else use `_resolve_octave` /
    `_resolve_octave_beats`, which shift the beats too: changing this number
    while leaving the grid at its original spacing is precisely the bug that
    made every downstream 8-count span the wrong amount of music.
    """
    if tempo <= 0 or not (slow < fast):
        return tempo
    t = tempo
    while t < slow:
        t *= 2.0
    while t > fast:
        t /= 2.0
    return t


# --- Uniform-grid fitting ----------------------------------------------------
#
# librosa returns beats quantised to the onset-envelope frame grid, so the
# inter-beat interval can only take a few discrete values and ping-pongs
# between them (e.g. 0.6080 s / 0.5760 s alternating -> +/-16 ms saw-tooth).
# That saw-tooth is exactly what users perceive as "the beat is off". Fitting a
# single global (period, phase) removes it entirely and, as a bonus, yields a
# BPM that is no longer quantised by the frame rate.


def _env_value_at(env, sr: int, hop: int, times):
    """Sample an onset-strength envelope at arbitrary (sub-frame) times.

    Linear interpolation between the two neighbouring frames is what gives the
    grid search sub-frame resolution; nearest-frame lookup would re-introduce
    the very quantisation we are trying to remove.

    Args:
      - env: 1-D onset strength envelope.
      - sr: sample rate the envelope was computed at.
      - hop: hop length (in samples) the envelope was computed with.
      - times: scalar or array of timestamps in seconds.

    Returns:
      A ``numpy.ndarray`` of interpolated envelope values, shaped like ``times``.
      Out-of-range timestamps clamp to the first / last frame.
    """
    import numpy as np

    e = np.asarray(env, dtype=float)
    t = np.asarray(times, dtype=float)
    if e.size == 0:
        return np.zeros(t.shape, dtype=float)
    frames = t * (float(sr) / float(hop))
    lo = np.floor(frames).astype(int)
    frac = frames - lo
    lo = np.clip(lo, 0, e.size - 1)
    hi = np.clip(lo + 1, 0, e.size - 1)
    return e[lo] * (1.0 - frac) + e[hi] * frac


def _lsq_period_phase(beats) -> Tuple[float, float]:
    """Least-squares fit of ``t_i = phase + i * period`` over tracked beats.

    Runs up to 3 re-weighting rounds that drop outliers (residual greater than
    ``max(3 * median(residual), 0.02)`` seconds) so a handful of mis-tracked
    beats cannot drag the period. Iteration stops early once nothing is
    rejected or fewer than 4 beats would remain.

    Args:
      - beats: monotonically increasing beat timestamps in seconds.

    Returns:
      ``(period, phase)`` in seconds. ``period`` is 0.0 when fewer than two
      beats were supplied.
    """
    import numpy as np

    b = np.asarray(beats, dtype=float)
    if b.size < 2:
        return 0.0, (float(b[0]) if b.size else 0.0)

    idx = np.arange(b.size, dtype=float)
    period = float(np.median(np.diff(b)))
    phase = float(b[0])
    for _ in range(3):
        mat = np.vstack([idx, np.ones_like(idx)]).T
        sol = np.linalg.lstsq(mat, b, rcond=None)[0]
        period, phase = float(sol[0]), float(sol[1])
        resid = np.abs(b - (phase + idx * period))
        thr = max(3.0 * float(np.median(resid)), 0.02)
        keep = resid <= thr
        if int(keep.sum()) < 4 or bool(keep.all()):
            break
        b, idx = b[keep], idx[keep]
    return period, phase


def _comb_search(
    env,
    sr: int,
    hop: int,
    p_init: float,
    t_lo: float,
    t_hi: float,
    rel: float,
    n_period: int,
    n_phase: int,
) -> Tuple[float, float, float]:
    """Comb-filter search for the (period, phase) with maximal onset energy.

    Sweeps ``period`` over ``p_init * (1 +/- rel)`` and, for each period,
    ``phase`` over one full period starting at ``t_lo``. For every candidate a
    comb of impulses ``phase + k * period`` is laid over the onset envelope and
    the interpolated energy summed.

    The score is normalised by ``sqrt(n_valid_beats)``: without it a shorter
    period always wins simply by placing more teeth on the envelope.

    Implementation note: the phase x beat comb is built as one
    ``(n_phase, n_beats)`` matrix and scored in a single vectorised pass, so
    only the period axis is a Python loop.

    Args:
      - env / sr / hop: the onset envelope and how it was computed.
      - p_init: centre of the period search range, in seconds.
      - t_lo / t_hi: time window the grid must cover, in seconds.
      - rel: relative half-width of the period sweep (e.g. 0.03 -> +/-3%).
      - n_period / n_phase: search resolution along each axis.

    Returns:
      ``(score, period, phase)``; score is -1.0 when no candidate was viable.
    """
    import numpy as np

    best: Tuple[float, float, float] = (-1.0, float(p_init), float(t_lo))
    if p_init <= 0 or t_hi <= t_lo:
        return best

    periods = np.linspace(p_init * (1.0 - rel), p_init * (1.0 + rel), int(n_period))
    for p_raw in periods:
        p = float(p_raw)
        if p <= 0:
            continue
        n_beats = int(np.floor((t_hi - t_lo) / p)) + 1
        if n_beats < 4:
            continue
        k = np.arange(n_beats, dtype=float)
        phases = float(t_lo) + np.linspace(0.0, p, int(n_phase), endpoint=False)
        grid = phases[:, None] + k[None, :] * p          # (n_phase, n_beats)
        valid = grid <= t_hi + 1e-9
        vals = _env_value_at(env, sr, hop, grid.ravel()).reshape(grid.shape)
        vals = np.where(valid, vals, 0.0)
        score = vals.sum(axis=1) / np.sqrt(np.maximum(valid.sum(axis=1), 1))
        i = int(np.argmax(score))
        if float(score[i]) > best[0]:
            best = (float(score[i]), p, float(phases[i]))
    return best


def _fit_uniform_grid(env, sr: int, hop: int, beats, t_lo: float, t_hi: float) -> Tuple[float, float, float]:
    """Two-stage fit of a single global (period, phase) to the tracked beats.

    Stage 0 seeds the period with a robust least-squares fit of the tracked
    beats, stage 1 does a coarse comb search (+/-3%, 121 x 256), stage 2 refines
    around the coarse winner (+/-0.4%, 41 x 512). The better-scoring of the two
    stages is returned.

    Measured on the real track this two-stage scheme beats an exhaustive
    601 x 400 search on *both* accuracy (11.8 ms vs 12.3 ms median distance to
    the nearest onset) and speed (0.09 s vs 0.36 s), and the gap widens on long
    audio (10 min / 1000 beats: 11.12 ms in 1.38 s vs 24.10 ms in 5.90 s).

    Returns:
      ``(score, period, phase)``; score is -1.0 when no fit was possible.
    """
    p_lsq, _phase_lsq = _lsq_period_phase(beats)
    if p_lsq <= 0:
        return -1.0, 0.0, float(t_lo)

    coarse = _comb_search(env, sr, hop, p_lsq, t_lo, t_hi, 0.03, 121, 256)
    if coarse[0] < 0 or coarse[1] <= 0:
        return coarse
    fine = _comb_search(env, sr, hop, coarse[1], t_lo, t_hi, 0.004, 41, 512)
    return fine if fine[0] >= coarse[0] else coarse


def _grid_score(env, sr: int, hop: int, beats) -> float:
    """Onset energy explained by a beat grid, normalised by ``sqrt(n_beats)``.

    Uses the exact same normalisation as `_comb_search` so the raw tracked grid
    and the fitted uniform grid can be compared on one scale.
    """
    import numpy as np

    b = np.asarray(beats, dtype=float)
    if b.size < 2:
        return 0.0
    return float(np.sum(_env_value_at(env, sr, hop, b)) / np.sqrt(b.size))


def _onset_contrast(env, sr: int, hop: int, beats) -> float:
    """How far above the background the onset envelope sits *at* the beats.

    The envelope's background floor (the ``GRID_CONF_FLOOR_PCT`` percentile) is
    subtracted first, then the ratio ``mean(env' at beats) / mean(env')`` is
    taken. 1.0 means the grid is statistically indistinguishable from dropping
    beats at random positions — it explains nothing about the audio; values
    well above 1 mean the grid is landing on real onsets.

    The floor subtraction is load-bearing. Without it a noisy or reverberant
    mix — which adds a large constant to every envelope frame — drags the ratio
    toward 1.0 no matter how well the grid fits, to the point where the metric
    stops separating real music from beatless material at all (see
    ``GRID_CONF_FLOOR_PCT``).

    Unlike `_grid_score` this is *scale free* (envelope magnitude cancels) and
    *length free* (a mean, not a sum), so one absolute threshold is meaningful
    across tracks of any loudness or duration. `_grid_score` is only ever used
    as a ratio between two grids of the same track, which is exactly why it
    cannot answer "is this grid any good in absolute terms?".

    Args:
      - env / sr / hop: the onset envelope and how it was computed.
      - beats: beat timestamps in seconds.

    Returns:
      The contrast ratio, or 0.0 for an empty / silent / perfectly flat
      envelope, or when fewer than two beats were supplied.
    """
    import numpy as np

    e = np.asarray(env, dtype=float)
    b = np.asarray(beats, dtype=float)
    if e.size == 0 or b.size < 2:
        return 0.0
    floor = float(np.percentile(e, GRID_CONF_FLOOR_PCT))
    e = np.maximum(e - floor, 0.0)
    base = float(np.mean(e))
    if base <= 0:
        return 0.0
    return float(np.mean(_env_value_at(e, sr, hop, b)) / base)


def _grid_path_confidence(env, sr: int, hop: int, beats) -> float:
    """Confidence for the uniform-grid path: how well the grid fits the music.

    `_confidence` alone is meaningless here: the fitted grid is perfectly even
    by construction, so its interval CV is always 0 and it always reports 1.0,
    permanently disabling the `beat_low_confidence` flag. We keep `_confidence`
    as a factor — it still zeroes out degenerate grids of fewer than 3 beats —
    and multiply it by an onset-contrast quality term that answers the question
    the user actually cares about: *does this grid line up with the music?*

        quality = clip((contrast - 1) / (GRID_CONF_FULL_CONTRAST - 1), 0, 1)

    This deliberately lives in its own function: `_confidence` keeps its pure
    interval-CV semantics for the fallback (raw + snap) path and for the tests
    that lock that contract.

    Returns:
      A confidence in ``[0, 1]``.
    """
    contrast = _onset_contrast(env, sr, hop, beats)
    span = GRID_CONF_FULL_CONTRAST - 1.0
    quality = ((contrast - 1.0) / span) if span > 0 else 0.0
    quality = max(0.0, min(1.0, quality))
    return float(max(0.0, min(1.0, _confidence(beats) * quality)))


def _build_grid(period: float, phase: float, t_hi: float, duration: float) -> List[float]:
    """Materialise ``phase + k * period`` beats inside ``[0, duration]``.

    Returns an empty list if the parameters are degenerate.
    """
    import numpy as np

    if period <= 0 or t_hi <= phase:
        return []
    n = int(np.floor((t_hi - phase) / period)) + 1
    if n <= 0:
        return []
    grid = phase + np.arange(n, dtype=float) * period
    grid = grid[(grid >= 0.0) & (grid <= duration)]
    return [float(t) for t in grid]


# --- Octave resolution -------------------------------------------------------


def _nearest_distance(a, b):
    """Distance from each element of ``a`` to the nearest element of sorted ``b``.

    Uses ``searchsorted`` rather than a pairwise distance matrix: on an hour of
    audio the matrix form would allocate hundreds of megabytes, while this is
    O(n log n) time and O(n) memory.

    Args:
      - a: 1-D array of query timestamps.
      - b: 1-D array of reference timestamps, **sorted ascending**.

    Returns:
      A ``numpy.ndarray`` of absolute distances, shaped like ``a``. All-inf when
      ``b`` is empty.
    """
    import numpy as np

    a = np.asarray(a, dtype=float)
    b = np.asarray(b, dtype=float)
    if b.size == 0:
        return np.full(a.shape, np.inf, dtype=float)
    idx = np.searchsorted(b, a)
    left = np.clip(idx - 1, 0, b.size - 1)
    right = np.clip(idx, 0, b.size - 1)
    return np.minimum(np.abs(a - b[left]), np.abs(a - b[right]))


def _onset_weights(env, sr: int, hop: int, onsets):
    """Salience of each detected onset: the floor-subtracted envelope there.

    Weighting recall by salience is what keeps additive noise from deciding the
    octave: a noisy mix produces many extra onset peaks, but they are weak, so
    they cannot outvote the real hits. The same ``GRID_CONF_FLOOR_PCT`` floor
    as `_onset_contrast` is subtracted, for the same reason.
    """
    import numpy as np

    e = np.asarray(env, dtype=float)
    o = np.asarray(onsets, dtype=float)
    if e.size == 0 or o.size == 0:
        return np.zeros(o.shape, dtype=float)
    floor = float(np.percentile(e, GRID_CONF_FLOOR_PCT))
    e = np.maximum(e - floor, 0.0)
    return _env_value_at(e, sr, hop, o)


def _octave_fitness(onsets, onset_w, grid, tol: float) -> float:
    """Strength-weighted onset F-measure of a candidate beat grid.

    ``precision`` is the fraction of *grid points* that have a detected onset
    within ``tol``; ``recall`` is the fraction of total onset *salience* that
    sits on a grid point. Their harmonic mean is the score.

    The point of the F-measure here is that it is **neutral in beat density**,
    which `_comb_search`'s ``sum(env)/sqrt(n)`` is not:

      * halve the beat density and recall collapses (half the music is no
        longer described by the grid);
      * double it and precision collapses (half the grid lands on nothing).

    Only a grid at the metrical level the audio actually supports maximises
    both at once. Measured over a 57-texture battery it picked the correct
    level 57/57, with a worst-case margin of 0.275 over the runner-up.

    Args:
      - onsets: detected onset timestamps in seconds, sorted ascending.
      - onset_w: salience weight per onset (see `_onset_weights`).
      - grid: candidate beat timestamps in seconds, sorted ascending.
      - tol: match tolerance in seconds.

    Returns:
      The F-measure in ``[0, 1]``; 0.0 for a degenerate grid (< 4 beats) or
      when nothing was detected.
    """
    import numpy as np

    g = np.asarray(grid, dtype=float)
    o = np.asarray(onsets, dtype=float)
    w = np.asarray(onset_w, dtype=float)
    if g.size < 4 or o.size == 0 or w.size != o.size:
        return 0.0
    precision = float(np.mean(_nearest_distance(g, o) <= tol))
    total = float(np.sum(w))
    if total <= 0:
        return 0.0
    recall = float(np.sum(w[_nearest_distance(o, g) <= tol]) / total)
    denom = precision + recall
    return float(2.0 * precision * recall / denom) if denom > 0 else 0.0


def _band_target_period(period: float, slow: float, fast: float) -> float:
    """Octave-shift ``period`` until its tempo lands inside ``[slow, fast]``.

    This is `_octave_clamp`'s arithmetic expressed on the period instead of on
    the tempo number, so the caller can rebuild the grid to match.
    """
    # `math.isfinite` is load-bearing: an infinite period would make
    # `60/target` zero forever and spin the first loop indefinitely.
    if not math.isfinite(period) or period <= 0 or not (0 < slow < fast):
        return period
    target = period
    while 60.0 / target < slow:
        target /= 2.0
    while 60.0 / target > fast:
        target *= 2.0
    return target


def _resolve_octave(
    onsets,
    onset_w,
    period: float,
    phase: float,
    t_hi: float,
    duration: float,
    slow: float,
    fast: float,
) -> float:
    """Choose the beat period to emit: the tempo band, gated on evidence.

    The band wants every reported tempo inside ``[slow, fast]``. Honouring it
    used to be free because only the number changed; now that the grid is
    rebuilt to match, the move has to be justified by the audio. So the moved
    grid is scored against the fitted one with `_octave_fitness` and the move
    is refused when it costs more than ``OCTAVE_F_MARGIN``.

    That gate is what stops a genuine 56-64 BPM ballad from having a beat
    invented between every pair of real ones just to get the number above
    ``slow`` — measured, such a densification costs ~0.33 F, far beyond the
    margin. Conversely a real backbeat, even a quiet one, *raises* the score
    when the grid is densified onto it, so those moves are accepted.

    Note this can only ever **refuse** a move the previous code performed
    unconditionally, so it cannot introduce a new failure mode.

    Scope — this function only ever sees fits that land *outside* the band. A
    half-tempo fit that lands inside it (176 BPM drum'n'bass tracked at 88) is
    not this function's problem: nothing asks for a move, so it is never even
    invoked. That case is handled by `_recover_fast_period`, which cannot use
    the F-measure at all — on 8th-note hi-hat material the subdivision grid
    scores 1.00 against 0.72 for the true beat, so an F-measure rule would send
    every hi-hat-heavy 90-110 BPM track to double tempo — and gates on
    *low-band* evidence instead.

    Returns:
      The period to build the emitted grid from (``period`` itself when the
      band is already satisfied or the move was refused).
    """
    if period <= 0:
        return period
    target = _band_target_period(period, slow, fast)
    if target == period or target <= 0:
        return period
    tol = min(OCTAVE_TOL, 0.2 * min(period, target))
    base_grid = _build_grid(period, phase, t_hi, duration)
    moved_grid = _build_grid(target, phase, t_hi, duration)
    if len(moved_grid) < 2:
        return period
    base_f = _octave_fitness(onsets, onset_w, base_grid, tol)
    moved_f = _octave_fitness(onsets, onset_w, moved_grid, tol)
    return period if moved_f < base_f - OCTAVE_F_MARGIN else target


def _densify_beats(beats: List[float]) -> List[float]:
    """Insert the midpoint between every consecutive pair (tempo x2)."""
    if len(beats) < 2:
        return list(beats)
    out: List[float] = []
    for i in range(len(beats) - 1):
        out.append(float(beats[i]))
        out.append((float(beats[i]) + float(beats[i + 1])) / 2.0)
    out.append(float(beats[-1]))
    return out


def _sparsify_beats(beats: List[float]) -> List[float]:
    """Keep every other beat (tempo /2)."""
    return [float(t) for t in list(beats)[::2]]


def _resolve_octave_beats(
    onsets,
    onset_w,
    beats: List[float],
    slow: float,
    fast: float,
) -> List[float]:
    """`_resolve_octave` for the fallback (raw + snap) path.

    The fallback beats are not uniform, so the octave move is applied to the
    *beat list* — inserting midpoints to densify, dropping every other beat to
    sparsify — rather than by rebuilding from a period. The same evidence gate
    applies, so the returned list and the BPM derived from it always agree.
    """
    import numpy as np

    b = [float(t) for t in beats]
    if len(b) < 2:
        return b
    med = float(np.median(np.diff(np.asarray(b, dtype=float))))
    if med <= 0:
        return b
    target = _band_target_period(med, slow, fast)
    if target == med or target <= 0:
        return b

    moved = b
    if target < med:
        for _ in range(int(round(math.log2(med / target)))):
            moved = _densify_beats(moved)
    else:
        for _ in range(int(round(math.log2(target / med)))):
            moved = _sparsify_beats(moved)
    if len(moved) < 2:
        return b

    tol = min(OCTAVE_TOL, 0.2 * min(med, target))
    base_f = _octave_fitness(onsets, onset_w, b, tol)
    moved_f = _octave_fitness(onsets, onset_w, moved, tol)
    return b if moved_f < base_f - OCTAVE_F_MARGIN else moved


# --- Genuine-fast recovery ---------------------------------------------------


def _lowband_onset_env(y, sr: int, hop: int):
    """Onset (spectral flux) envelope restricted to the kick/snare band.

    Two things make this deliberately different from the full-band
    `librosa.onset.onset_strength` envelope used everywhere else:

      * **Band limited** to ``[LOW_BAND_FMIN, LOW_BAND_FMAX]``. That is the
        whole point — it sees kick and snare and is blind to the hi-hats that
        make a plain "is the denser grid better?" test unusable.
      * **Linear magnitude**, not decibels. ``onset_strength`` fluxes a
        dB-scaled mel spectrogram, and that log compression is fatal here: a
        ghost note at 25% amplitude came out at 0.93 of a full hit, so quiet
        ornaments were indistinguishable from real beats. On the linear
        magnitude the same ghost measures 0.25, which is exactly the
        distinction the gate has to make.

    Args:
      - y: mono audio samples.
      - sr: sample rate of ``y``.
      - hop: hop length in samples (use ``HOP_FINE`` to match the other
        envelopes so `_env_value_at` can sample it on the same time base).

    Returns:
      A 1-D ``numpy.ndarray`` of non-negative flux, one value per frame.
    """
    import librosa
    import numpy as np

    samples = np.asarray(y, dtype=np.float32)
    if samples.size < LOW_BAND_N_FFT:
        return np.zeros(0, dtype=float)
    spec = np.abs(librosa.stft(samples, n_fft=LOW_BAND_N_FFT, hop_length=hop))
    freqs = librosa.fft_frequencies(sr=sr, n_fft=LOW_BAND_N_FFT)
    band = (freqs >= LOW_BAND_FMIN) & (freqs <= LOW_BAND_FMAX)
    if not bool(band.any()):
        return np.zeros(spec.shape[1], dtype=float)
    energy = spec[band, :].sum(axis=0)
    # Half-wave rectified first difference: only *rises* in low-band energy
    # count as hits, so a sustained bass note is not mistaken for a drum.
    return np.maximum(np.diff(energy, prepend=energy[:1]), 0.0).astype(float)


def _lowband_peaks(env, sr: int, hop: int, times, tol: float):
    """Strongest low-band flux within ``+/- tol`` of each timestamp.

    A window maximum rather than a point sample: the low-band flux of a drum
    hit is a one-frame spike, so reading the envelope exactly at the grid time
    misses it whenever the fitted phase is off by a frame (measured: the
    evidence for genuinely fast material collapsed to 0.000 with point
    sampling). On-beats and midpoints are read the same way, so the comparison
    between them stays fair.
    """
    import numpy as np

    t = np.asarray(times, dtype=float)
    if t.size == 0:
        return np.zeros(0, dtype=float)
    offsets = np.linspace(-tol, tol, LOW_BAND_PROBES)
    probes = t[:, None] + offsets[None, :]
    vals = _env_value_at(env, sr, hop, probes.ravel()).reshape(probes.shape)
    return vals.max(axis=1)


def _midpoint_lowband_evidence(
    env_low, sr: int, hop: int, on_times, mid_times, tol: float
) -> Tuple[float, float]:
    """Evidence that the midpoints between the beats are themselves beats.

    Returns ``(ratio, contrast)``:

      * ``ratio`` — mean low-band level at the midpoints over the
        ``LOW_BAND_ON_PCT`` percentile of the level at the beats already in the
        grid. Answers "is the inserted beat as punchy as the real ones?", which
        is what tells a fast track's kick apart from a slow track's off-beat
        ornament.
      * ``contrast`` — mean low-band level at the midpoints over the track's
        mean low-band flux. Answers "is there anything there at all?", which is
        what tells both of those apart from beatless audio, where the ratio is
        ~1.0 purely because both levels are background.

    Both are needed; see ``LOW_MID_RATIO`` / ``LOW_MID_CONTRAST``. Returns
    ``(0.0, 0.0)`` for degenerate input.
    """
    import numpy as np

    e = np.asarray(env_low, dtype=float)
    if e.size == 0:
        return 0.0, 0.0
    on = _lowband_peaks(e, sr, hop, on_times, tol)
    mid = _lowband_peaks(e, sr, hop, mid_times, tol)
    if on.size < 2 or mid.size < 2:
        return 0.0, 0.0
    mid_level = float(np.mean(mid))
    strong_on = float(np.percentile(on, LOW_BAND_ON_PCT))
    base = float(np.mean(e))
    ratio = (mid_level / strong_on) if strong_on > 0 else 0.0
    contrast = (mid_level / base) if base > 0 else 0.0
    return ratio, contrast


def _midpoints_are_beats(env_low, sr: int, hop: int, on_times, mid_times, tol: float) -> bool:
    """True when the low band proves the midpoints carry real drum hits."""
    ratio, contrast = _midpoint_lowband_evidence(env_low, sr, hop, on_times, mid_times, tol)
    return ratio >= LOW_MID_RATIO and contrast >= LOW_MID_CONTRAST


def _recover_fast_period(
    low_env: Callable[[], object],
    sr: int,
    hop: int,
    period: float,
    phase: float,
    t_hi: float,
    duration: float,
    fast: float,
) -> float:
    """Halve an in-band half-tempo fit that the low band shows is half speed.

    This is the counterpart to `_resolve_octave`: that one handles fits which
    land *outside* the tempo band, this one handles the case the band cannot
    see — a 176 BPM track fitted at 88, where 88 is perfectly in-band so no
    move is ever requested (see the module-level notes).

    The move is refused unless every inserted midpoint carries a genuine
    low-frequency hit, which is what keeps 8th-note hi-hat material — far more
    common in this app than 176+ BPM — from being doubled.

    Args:
      - low_env: zero-argument callable returning the low-band onset envelope.
        A callable rather than the envelope itself so the extra STFT is only
        paid for by tracks that are actually candidates: a fit above ~102 BPM
        cannot double without leaving the band, and that covers most real
        material, so this returns before the envelope is ever built.
      - sr / hop: sample rate and hop the envelope is computed at.
      - period / phase / t_hi / duration: the fitted grid, as for `_build_grid`.
      - fast: top of the tempo band (``FAST_BEAT_BPM``).

    Returns:
      ``period / 2`` when the recovery is justified, otherwise ``period``
      unchanged. Like `_resolve_octave` it can only ever *refuse*, so a
      degenerate input silently keeps the fitted period.
    """
    if not math.isfinite(period) or period <= 0 or fast <= 0:
        return period
    half = period / 2.0
    # Doubling must not walk out of the tempo band (plus the numerical slack
    # that keeps material sitting exactly on the band edge recoverable).
    if 60.0 / half > fast * (1.0 + OCTAVE_BAND_SLACK):
        return period
    on_times = _build_grid(period, phase, t_hi, duration)
    mid_times = _build_grid(period, phase + half, t_hi, duration)
    if len(on_times) < 4 or len(mid_times) < 4:
        return period
    # Tolerance is tied to the *doubled* spacing so the on-beat and midpoint
    # windows can never overlap, which would make the comparison meaningless.
    tol = min(OCTAVE_TOL, 0.2 * half)
    return half if _midpoints_are_beats(low_env(), sr, hop, on_times, mid_times, tol) else period


def _recover_fast_beats(
    low_env: Callable[[], object],
    sr: int,
    hop: int,
    beats: List[float],
    fast: float,
) -> List[float]:
    """`_recover_fast_period` for the fallback (raw + snap) path.

    The fallback beats are not uniform, so — exactly as `_resolve_octave_beats`
    does — the move is applied to the beat *list* via `_densify_beats` and the
    midpoints are taken between consecutive beats rather than from a period.
    ``low_env`` is a callable for the same reason as above.
    """
    import numpy as np

    b = [float(t) for t in beats]
    if len(b) < 4 or fast <= 0:
        return b
    arr = np.asarray(b, dtype=float)
    med = float(np.median(np.diff(arr)))
    if med <= 0:
        return b
    half = med / 2.0
    if 60.0 / half > fast * (1.0 + OCTAVE_BAND_SLACK):
        return b
    mid_times = (arr[:-1] + arr[1:]) / 2.0
    if mid_times.size < 4:
        return b
    tol = min(OCTAVE_TOL, 0.2 * half)
    if _midpoints_are_beats(low_env(), sr, hop, arr, mid_times, tol):
        return _densify_beats(b)
    return b


# One-time JIT warm-up guard. librosa's onset_strength / beat_track /
# onset_detect trigger numba/llvmlite JIT on their first call; under uvicorn's
# daemon threads that first call deadlocks. We pre-compile them once on the
# worker's main thread (see app/main.py lifespan) and reuse the cached
# Dispatchers everywhere else.
_warmup_lock = threading.Lock()
_warmup_done = False


def warmup() -> None:
    """Force-compile the librosa/numba functions used by ``detect``.

    librosa's ``onset_strength`` / ``beat_track`` / ``onset_detect`` trigger a
    numba/llvmlite JIT *on their first call*. Under uvicorn's daemon threads
    that first call deadlocks and hangs the background pipeline forever (no
    error, no return — the task freezes at ``beat_detecting``). By compiling
    them once on the worker's main thread (the FastAPI startup event) the
    compiled Dispatchers are cached in-process and reused by every later
    thread, so the daemon pipeline never re-enters the JIT compiler.

    IMPORTANT: this must mirror *every* librosa call signature used by
    ``detect`` — the sample rate and **both** hop lengths (``HOP_TRACK`` for
    tracking, ``HOP_FINE`` for the fine envelope / onset peaks). A warm-up that
    uses different parameters leaves an un-compiled specialisation behind and
    the deadlock comes straight back.

    Idempotent and safe to call repeatedly; the heavy compile runs at most once.
    """
    global _warmup_done
    if _warmup_done:
        return
    with _warmup_lock:
        if _warmup_done:
            return
        import logging

        try:
            import librosa
            import numpy as np

            from ..core.config import DEFAULT_BPM

            logging.getLogger(__name__).info("beat_detector: warming up librosa JIT (one-time)…")
            sr = ANALYSIS_SR
            # 1.5 s so even the hop=128 envelope gets a few hundred frames —
            # beat_track needs a usable tempogram to exercise every JIT path.
            dur = 1.5
            n = int(sr * dur)
            t = np.linspace(0.0, dur, n, endpoint=False)
            rng = np.random.default_rng(0)
            # Light sine partials + a touch of noise so onset/beat features have
            # something meaningful to latch onto. Purely synthetic — no disk IO.
            y = (
                0.3 * np.sin(2.0 * np.pi * 220.0 * t)
                + 0.2 * np.sin(2.0 * np.pi * 330.0 * t)
                + 0.1 * rng.standard_normal(n)
            ).astype(np.float32)

            # Mirror the exact librosa calls made by detect() so every JIT path
            # that detect() will hit is compiled here on the main thread.
            env_track = librosa.onset.onset_strength(y=y, sr=sr, hop_length=HOP_TRACK)
            _tempo, frames = librosa.beat.beat_track(
                y=y,
                sr=sr,
                onset_envelope=env_track,
                hop_length=HOP_TRACK,
                start_bpm=DEFAULT_BPM,
            )
            librosa.frames_to_time(frames, sr=sr, hop_length=HOP_TRACK)

            env_fine = librosa.onset.onset_strength(y=y, sr=sr, hop_length=HOP_FINE)
            librosa.onset.onset_detect(
                y=y,
                sr=sr,
                onset_envelope=env_fine,
                hop_length=HOP_FINE,
                units="time",
            )

            # Low-band envelope used by the genuine-fast recovery. It is only
            # built for *some* tracks, which is exactly why it must be warmed
            # here: the first track that needs it would otherwise enter the JIT
            # from a daemon thread and hang the pipeline.
            _lowband_onset_env(y, sr, HOP_FINE)
            _warmup_done = True
            logging.getLogger(__name__).info("beat_detector: warmup complete")
        except Exception as exc:  # noqa: BLE001 - never block startup on a failed warmup
            logging.getLogger(__name__).warning(
                "beat_detector warmup failed (detect will JIT-compile lazily): %s", exc
            )


def detect(
    wav_path: str,
    progress_callback: Optional[Callable[[int], None]] = None,
) -> Tuple[float, float, List[float], float]:
    """Run beat tracking.

    Returns (bpm, confidence, beat_times, duration).
      - beat_times: per-beat timestamps in seconds (the source of truth for 8-count segmentation)
      - bpm: display tempo after octave correction
      - confidence: 0~1. How much the emitted grid can be trusted. On the
        uniform-grid path this is onset-contrast based (`_grid_path_confidence`)
        because a fitted grid is perfectly even by construction; on the
        raw + snap fallback path it is interval stability (`_confidence`).
      - duration: audio duration in seconds

    Args:
      - wav_path: path to a mono 16-bit WAV file. ``audio_extractor`` emits
        22.05 kHz to match ``ANALYSIS_SR``, but any sample rate works — it is
        resampled on load, so WAVs extracted by older builds still analyse fine.
      - progress_callback: optional ``Callable[[int], None]`` invoked with a
        percentage (0-100) at major pipeline milestones. Used by the task
        manager so the frontend never appears frozen during analysis.

    Analysis front-end (2026-08-01)
    -------------------------------
    Audio is decoded at ``ANALYSIS_SR`` = 22050 Hz, beats are tracked on a
    ``HOP_TRACK`` = 256 onset envelope, and a second ``HOP_FINE`` = 128
    envelope drives snapping, grid fitting and scoring. Versus the previous
    16 kHz / hop-512 front-end this places beats ~2.4x closer to the real
    onsets (median 41.1 ms -> 17.4 ms from the nearest onset).

    Uniform-grid refinement + adaptive fallback
    -------------------------------------------
    librosa can only place beats on envelope frame boundaries, so the reported
    inter-beat interval ping-pongs between two quantised values (measured on a
    real 43 s track: 0.6080 s x35 and 0.5760 s x28, i.e. a +/-16 ms saw-tooth,
    IBI std 22.75 ms). Users experience that saw-tooth as "the beat is off",
    and taking ``median(IBI)`` on top of it reports the wrong tempo (98.68 BPM
    where the true tempo is ~101.0).

    We therefore fit a single global ``(period, phase)`` to the tracked beats
    (`_fit_uniform_grid`) and, when it holds up, emit that perfectly even grid
    with ``bpm = 60 / period`` — a tempo that is no longer frame-quantised.

    Because a uniform grid is catastrophically wrong for accelerando / medley
    material, the choice is made adaptively per track::

        use_grid = (grid_score / raw_score >= GRID_SCORE_TOL)
                   and (cv(raw_beats) <= GRID_MAX_CV)

    Both statistics are taken on the *raw* tracked beats, which is exactly how
    the thresholds were calibrated. A 12-combination threshold sweep over 9
    scenarios (constant 90/110/128 BPM, +/-15 ms and +/-25 ms jitter, 100->130
    ramp, 120->126 micro-drift, a 100|125 tempo-jump medley and the real track)
    misclassified nothing, so the gate is safe. When it says "no" we fall back
    to the previous raw + snap behaviour.

    Long-audio robustness (Bug D) — REVISED (2026-07-24)
    ----------------------------------------------------
    The original Bug-D fix estimated a *robust* global BPM with
    ``librosa.beat.tempo(onset_envelope=..., aggregate=None)`` — a per-window
    tempo estimate over ~1357 windows. In a normal process this takes ~5.6s and
    is acceptable, **but under uvicorn's daemon thread + ``--reload`` it triggers
    numba/llvmlite JIT contention that permanently hangs the background pipeline
    (no error, no return — the task freezes at ``beat_detecting`` forever).**

    We therefore REMOVE the per-window ``beat.tempo`` call entirely. Tempo
    robustness is recovered by the remaining, fast, thread-safe mechanisms:

      1. A single ``beat_track(start_bpm=DEFAULT_BPM=120)`` (the original fast
         path, < 1s, no JIT-heavy aggregate op).
      2. Octave correction: if the locked tempo lands at half/double tempo,
         re-track once at the corrected prior and keep the steadier grid.
      3. **Snapping every detected beat to the nearest onset peak** within
         ±SNAP_WINDOW seconds. This anchors each beat to a real musical event,
         which is the actual fix for cumulative drift on long / rubato audio and
         is computationally trivial.
      4. Reporting BPM from the fitted grid period when the uniform grid wins,
         otherwise from the *median* inter-beat interval (octave-corrected).

    The net result: the drift-eliminating behaviour of Bug D is preserved while
    the hang-inducing operation is gone.

    Confidence semantics (2026-08-02)
    ---------------------------------
    Confidence used to be ``_confidence(beat_times)`` — the inter-beat-interval
    CV — on *both* paths. That is a bug on the grid path: the fitted grid is
    perfectly even by construction, so its CV is identically 0 and confidence
    was a hard-coded 1.0 for every grid-path analysis. ``beat_low_confidence``
    (``confidence < LOW_CONFIDENCE_THRESHOLD``) therefore never fired and the
    frontend's "low confidence, please recalibrate" prompt was dead code in
    exactly the situation it exists for: a grid that looks immaculate because
    it is even, but does not line up with the music.

    The grid path now reports `_grid_path_confidence`, which measures how much
    of the onset envelope the grid actually explains (see
    ``GRID_CONF_FULL_CONTRAST``). The fallback path keeps `_confidence`, where
    interval stability genuinely is the thing worth measuring.
    """
    import logging

    import librosa
    import numpy as np

    y, sr = librosa.load(wav_path, sr=ANALYSIS_SR, mono=True)
    duration = float(len(y)) / float(sr)
    if duration <= 0:
        return 0.0, 0.0, [], 0.0

    # Milestone: audio loaded. (Percentages stay monotonic with the 40 already
    # set by the pipeline when entering beat detection, so the bar always moves
    # forward rather than regressing.)
    if progress_callback is not None:
        try:
            progress_callback(50)
        except Exception:
            pass

    from ..core.config import FAST_BEAT_BPM, SLOW_BEAT_BPM, DEFAULT_BPM

    # Tracking envelope (hop 256). Passing it explicitly keeps beat_track and
    # frames_to_time on the same grid — omitting hop_length there would silently
    # fall back to librosa's default 512 and mis-convert every frame to seconds.
    env_track = librosa.onset.onset_strength(y=y, sr=sr, hop_length=HOP_TRACK)

    def _track(start_bpm: float) -> Tuple[float, List[float]]:
        # Beat frames -> seconds. `units` is omitted to stay compatible across
        # librosa 0.9/0.10/0.11 (default returns frames); we convert explicitly.
        tempo, beats = librosa.beat.beat_track(
            y=y,
            sr=sr,
            onset_envelope=env_track,
            hop_length=HOP_TRACK,
            start_bpm=start_bpm,
        )
        times = [float(t) for t in librosa.frames_to_time(beats, sr=sr, hop_length=HOP_TRACK)]
        return _as_float(tempo), times

    # Fast primary path: a single beat_track at the default BPM. This is the
    # original, thread-safe beat-detection call that never hangs.
    tempo, beat_times = _track(DEFAULT_BPM)

    # Milestone: primary beat track complete.
    if progress_callback is not None:
        try:
            progress_callback(60)
        except Exception:
            pass

    # Octave correction (existing pattern): if the grid sits at half/double
    # tempo, re-track and keep whichever grid is steadier.
    eff = _effective_tempo(beat_times)
    if eff < SLOW_BEAT_BPM or eff > FAST_BEAT_BPM:
        alt_start = eff * 2.0 if eff < SLOW_BEAT_BPM else eff / 2.0
        tempo2, beat_times2 = _track(alt_start)
        if _confidence(beat_times2) >= _confidence(beat_times):
            tempo, beat_times = tempo2, beat_times2
            eff = _effective_tempo(beat_times)

    # The raw tracked grid, kept untouched: it is both the fallback output and
    # the reference the uniform-grid arbitration is calibrated against.
    raw_times: List[float] = list(beat_times)

    # Fine envelope (hop 128) — sub-frame resolution for snapping and fitting.
    env_fine = librosa.onset.onset_strength(y=y, sr=sr, hop_length=HOP_FINE)

    # Beat post-processing: snap every beat to the nearest onset peak so
    # long-audio beats stop drifting from the real music. Each beat is
    # anchored within ±SNAP_WINDOW of an actual onset; otherwise kept.
    onset_times = np.asarray(
        librosa.onset.onset_detect(
            y=y,
            sr=sr,
            onset_envelope=env_fine,
            hop_length=HOP_FINE,
            units="time",
        ),
        dtype=float,
    )
    # Salience of each onset, reused by the octave resolution below so noisy
    # mixes (many weak spurious peaks) cannot outvote the real hits.
    onset_w = _onset_weights(env_fine, sr, HOP_FINE, onset_times)

    # Low-band (kick/snare) envelope for the genuine-fast recovery. Built
    # lazily: only a fit that is a *candidate* for being half speed needs it,
    # and on long audio the extra STFT is not worth paying for every track.
    env_low = None

    def _low_env():
        nonlocal env_low
        if env_low is None:
            env_low = _lowband_onset_env(y, sr, HOP_FINE)
        return env_low

    snapped: List[float] = []
    for bt in raw_times:
        if onset_times.size > 0:
            idx = int(np.argmin(np.abs(onset_times - bt)))
            if abs(onset_times[idx] - bt) <= SNAP_WINDOW:
                snapped.append(float(onset_times[idx]))
            else:
                snapped.append(bt)
        else:
            snapped.append(bt)
    # Drop any duplicate/collapsed timestamps produced by snapping.
    cleaned: List[float] = []
    prev_t = -1.0
    for t in snapped:
        if t > prev_t:
            cleaned.append(t)
            prev_t = t
    if len(cleaned) >= 2:
        beat_times = cleaned
    else:
        beat_times = raw_times
    # (If snapping collapsed the grid below 2 beats, keep the raw track.)

    # --- Uniform-grid refinement, with an adaptive fallback ------------------
    # Any failure here must degrade to the raw + snap grid above rather than
    # break the analysis, hence the blanket try/except.
    grid_period = 0.0
    use_grid = False
    if len(raw_times) >= 4:
        try:
            raw_arr = np.asarray(raw_times, dtype=float)
            period_init = float(np.median(np.diff(raw_arr)))
            if period_init > 0:
                t_lo = float(raw_arr[0]) - period_init * 0.5
                t_hi = float(raw_arr[-1]) + period_init * 0.5
                score, period, phase = _fit_uniform_grid(
                    env_fine, sr, HOP_FINE, raw_arr, t_lo, t_hi
                )
                if score > 0 and period > 0:
                    grid_times = _build_grid(period, phase, t_hi, duration)
                    if len(grid_times) >= 2:
                        raw_score = _grid_score(env_fine, sr, HOP_FINE, raw_arr)
                        grid_sc = _grid_score(env_fine, sr, HOP_FINE, grid_times)
                        ratio = (grid_sc / raw_score) if raw_score > 0 else 0.0
                        raw_cv = _interval_cv(raw_arr)
                        if ratio >= GRID_SCORE_TOL and raw_cv <= GRID_MAX_CV:
                            # Octave resolution happens *here*, after the grid
                            # has won the arbitration but before it is emitted,
                            # so the band can never change the reported number
                            # without changing the beats it describes. Running
                            # it after arbitration also leaves the (separately
                            # calibrated) grid-vs-raw comparison untouched.
                            period = _resolve_octave(
                                onset_times,
                                onset_w,
                                period,
                                phase,
                                t_hi,
                                duration,
                                SLOW_BEAT_BPM,
                                FAST_BEAT_BPM,
                            )
                            # `_resolve_octave` can only act on fits that fall
                            # *outside* the band. A genuinely fast track fitted
                            # at half tempo lands inside it, so nothing above
                            # asks for a move; recover those here, on low-band
                            # evidence, and rebuild from the halved period so
                            # the number still describes the emitted beats.
                            period = _recover_fast_period(
                                _low_env,
                                sr,
                                HOP_FINE,
                                period,
                                phase,
                                t_hi,
                                duration,
                                RECOVER_CEIL_BPM,
                            )
                            resolved = _build_grid(period, phase, t_hi, duration)
                            if len(resolved) >= 2:
                                beat_times = resolved
                                grid_period = period
                                use_grid = True
        except Exception as exc:  # noqa: BLE001 - never fail the analysis on a fit
            logging.getLogger(__name__).warning(
                "beat_detector: uniform-grid fit failed, falling back to raw+snap: %s", exc
            )
            grid_period = 0.0
            use_grid = False

    # Milestone: snapping / post-processing complete.
    if progress_callback is not None:
        try:
            progress_callback(75)
        except Exception:
            pass

    # BPM: straight from the resolved grid period when the uniform grid won
    # (free of frame quantisation), otherwise from the median inter-beat
    # interval (resists local jitter).
    #
    # Both branches derive the number *from the beats being returned*, and the
    # octave has already been resolved on the beats themselves, so the core
    # invariant holds unconditionally:
    #
    #     60 / median(diff(beat_times))  ==  bpm
    #
    # This is the whole point of the change. `_octave_clamp` used to be applied
    # to the number here, which broke that equality on 15 of 34 measured
    # textures and made every 8-count span the wrong amount of music.
    if use_grid and grid_period > 0:
        bpm = round(60.0 / grid_period, 2)
    elif len(beat_times) >= 2:
        # This branch *is* the safety net for a failed grid fit, so it must not
        # be the thing that breaks the analysis: on any error keep the beats
        # exactly as tracked and derive the number from them, which still
        # satisfies the invariant.
        try:
            beat_times = _resolve_octave_beats(
                onset_times, onset_w, beat_times, SLOW_BEAT_BPM, FAST_BEAT_BPM
            )
            # Same in-band half-tempo recovery as the grid path, applied to the
            # beat list. Kept as a sibling call rather than folded into
            # `_resolve_octave_beats` so each function keeps one job: that one
            # honours the tempo band, this one fixes a fit the band cannot see.
            beat_times = _recover_fast_beats(
                _low_env, sr, HOP_FINE, beat_times, RECOVER_CEIL_BPM
            )
        except Exception as exc:  # noqa: BLE001 - never fail the analysis
            logging.getLogger(__name__).warning(
                "beat_detector: octave resolution failed on the fallback path, "
                "keeping the tracked beats: %s",
                exc,
            )
        bpm = round(_effective_tempo_median(beat_times), 2)
    elif tempo:
        bpm = round(_octave_clamp(_as_float(tempo), SLOW_BEAT_BPM, FAST_BEAT_BPM), 2)
    else:
        bpm = round(float(DEFAULT_BPM), 2)

    # Confidence. The two output paths need *different* measures:
    #
    #   * grid path — the emitted beats are perfectly even by construction, so
    #     interval CV is identically 0 and `_confidence` would hand back a
    #     constant 1.0, making `beat_low_confidence` unreachable. Score how well
    #     the grid explains the onset envelope instead.
    #   * fallback (raw + snap) path — the beats follow the tracker, so their
    #     interval stability *is* the meaningful signal; keep `_confidence`.
    if use_grid:
        confidence = _grid_path_confidence(env_fine, sr, HOP_FINE, beat_times)
    else:
        confidence = _confidence(beat_times)
    return bpm, confidence, beat_times, duration
