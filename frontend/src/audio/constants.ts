// Algorithm constants for browser-side beat detection.
// Values mirror backend/app/core/config.py and beat_detector.py.

/** Target analysis sample rate (Hz). Audio is decoded/resampled to this. */
export const ANALYSIS_SR = 22050

/** Hop length (samples) for the track-scale onset envelope. */
export const HOP_TRACK = 256

/** Hop length (samples) for the fine-scale onset envelope. */
export const HOP_FINE = 128

/** Default BPM used for uniform-grid fallback. */
export const DEFAULT_BPM = 120

/** Confidence below this is flagged as low (mirrors backend). */
export const LOW_CONFIDENCE_THRESHOLD = 0.6

/** Inclusive BPM bounds for the fixedBpm mode. */
export const BPM_MIN = 40
export const BPM_MAX = 300

/** Soft duration cap (seconds) — warn, do not hard-reject. */
export const MAX_DURATION_SEC = 300

/** Hard file size cap (MB). */
export const MAX_SIZE_MB = 500
