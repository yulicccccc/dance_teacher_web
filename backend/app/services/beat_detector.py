"""BPM / beat detection built on librosa.

librosa and numpy are imported lazily inside the functions so the web app (and
`GET /health`) can boot even on machines where those heavy native deps are not
yet installed; only an actual analysis invocation will surface a clear error.
"""
from __future__ import annotations

import threading
from typing import Callable, List, Optional, Tuple


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


def _octave_clamp(tempo: float, slow: float, fast: float) -> float:
    """Push a tempo estimate into [slow, fast] by octave doubling/halving.

    A locked-on tempo is musically correct; only the *number* may be off by a
    power of two (librosa sometimes reports half/double tempo).
    """
    if tempo <= 0 or not (slow < fast):
        return tempo
    t = tempo
    while t < slow:
        t *= 2.0
    while t > fast:
        t /= 2.0
    return t


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

            logging.getLogger(__name__).info("beat_detector: warming up librosa JIT (one-time)…")
            sr = 16000
            n = int(sr * 0.75)  # 0.75 s — plenty to trigger every JIT path
            t = np.linspace(0.0, 0.75, n, endpoint=False)
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
            onset_env = librosa.onset.onset_strength(y=y, sr=sr)
            librosa.beat.beat_track(y=y, sr=sr, start_bpm=120)
            librosa.onset.onset_detect(
                y=y, sr=sr, onset_envelope=onset_env, units="time"
            )
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
      - confidence: 0~1 grid stability
      - duration: audio duration in seconds

    Args:
      - wav_path: path to a mono 16kHz 16-bit WAV file.
      - progress_callback: optional ``Callable[[int], None]`` invoked with a
        percentage (0-100) at major pipeline milestones. Used by the task
        manager so the frontend never appears frozen during analysis.

    Long-audio robustness (Bug D) — REVISED (2026-07-24)
    ----------------------------------------------------
    The original Bug-D fix estimated a *robust* global BPM with
    ``librosa.beat.tempo(onset_envelope=..., aggregate=None)`` — a per-window
    tempo estimate over ~1357 windows. In a normal process this takes ~5.6s and
    is acceptable, **but under uvicorn's daemon thread + ``--reload`` it triggers
    numba/llvmlite JIT contention that permanently hangs the background pipeline
    (no error, no return — the task freezes at ``beat_detecting`` forever).**

    We therefore REMOVE the per-window ``beat.tempo`` call entirely. Tempo
    robustness is recovered by the two remaining, fast, thread-safe mechanisms:

      1. A single ``beat_track(start_bpm=DEFAULT_BPM=120)`` (the original fast
         path, < 1s, no JIT-heavy aggregate op).
      2. Octave correction: if the locked tempo lands at half/double tempo,
         re-track once at the corrected prior and keep the steadier grid.
      3. **Snapping every detected beat to the nearest onset peak** within
         ±SNAP_WINDOW seconds. This anchors each beat to a real musical event,
         which is the actual fix for cumulative drift on long / rubato audio and
         is computationally trivial.
      4. Reporting BPM from the *median* inter-beat interval (octave-corrected),
         and confidence from IBI stability.

    The net result: the drift-eliminating behaviour of Bug D is preserved while
    the hang-inducing operation is gone.
    """
    import librosa
    import numpy as np

    y, sr = librosa.load(wav_path, sr=16000, mono=True)
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

    SNAP_WINDOW = 0.06  # seconds — max distance to snap a beat to an onset peak

    def _track(start_bpm: float) -> Tuple[float, List[float]]:
        # Beat frames -> seconds. `units` is omitted to stay compatible across
        # librosa 0.9/0.10/0.11 (default returns frames); we convert explicitly.
        tempo, beats = librosa.beat.beat_track(y=y, sr=sr, start_bpm=start_bpm)
        times = [float(t) for t in librosa.frames_to_time(beats, sr=sr)]
        return _as_float(tempo), times

    # Onset envelope — needed for snapping later (fast; NOT the culprit).
    onset_env = librosa.onset.onset_strength(y=y, sr=sr)

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

    # Beat post-processing: snap every beat to the nearest onset peak so
    # long-audio beats stop drifting from the real music. Each beat is
    # anchored within ±SNAP_WINDOW of an actual onset; otherwise kept.
    onset_times = np.asarray(
        librosa.onset.onset_detect(y=y, sr=sr, onset_envelope=onset_env, units="time"),
        dtype=float,
    )
    snapped: List[float] = []
    for bt in beat_times:
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
    # (If snapping collapsed the grid below 2 beats, keep the raw track.)

    # Milestone: snapping / post-processing complete.
    if progress_callback is not None:
        try:
            progress_callback(75)
        except Exception:
            pass

    # BPM from the median inter-beat interval (resists local jitter) with an
    # octave clamp into the valid tempo band; confidence from IBI stability.
    if len(beat_times) >= 2:
        bpm = _octave_clamp(_effective_tempo_median(beat_times), SLOW_BEAT_BPM, FAST_BEAT_BPM)
        bpm = round(bpm, 2)
    elif tempo:
        bpm = round(_octave_clamp(_as_float(tempo), SLOW_BEAT_BPM, FAST_BEAT_BPM), 2)
    else:
        bpm = round(float(DEFAULT_BPM), 2)
    confidence = _confidence(beat_times)
    return bpm, confidence, beat_times, duration
