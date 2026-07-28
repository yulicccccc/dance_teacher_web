import type { EssentiaInstance } from '../types/essentia'
import type { AudioData, BeatDetectionResult } from '../types/audio'

export interface DetectBeatsOptions {
  /** Abort signal (checked before the CPU-bound call). */
  signal?: AbortSignal
}

/**
 * Beat-detection algorithms supported locally.
 *
 * - `rhythm2013` is the default (essentia `RhythmExtractor2013`).
 * - `tempoTap` (`TempoTapDegara`) and `beatTracker` (`BeatTrackerMultiFeatures`)
 *   are reserved for the cross-validation path described in the architecture
 *   (§5.2). Wiring them in as a parallel detector for low-confidence fallback is
 *   a follow-up; the pipeline currently uses `rhythm2013` only.
 */
export type BeatAlgorithm = 'rhythm2013' | 'tempoTap' | 'beatTracker'

/**
 * Detect tempo + beats with essentia.js `RhythmExtractor2013`.
 *
 * `RhythmExtractor2013` is a composite algorithm compiled into the full
 * essentia.js build — it needs no extra model files. It returns the global BPM,
 * a vector of beat onset times (seconds), and a confidence in [0, 1]. The exact
 * output field names vary slightly across essentia.js versions (`beats` vs
 * `ticks`); we read both defensively, and if `confidence` is missing we fall
 * back to a neutral 1.0 so downstream low-confidence handling stays sane.
 */
export async function detectBeats(
  essentia: EssentiaInstance,
  audio: AudioData,
  opts: DetectBeatsOptions = {},
): Promise<BeatDetectionResult> {
  if (opts.signal?.aborted) {
    const err = new Error('节拍检测已取消')
    err.name = 'AbortError'
    throw err
  }

  const signalVector = essentia.arrayToVector(audio.samples)
  const out = essentia.RhythmExtractor2013(signalVector, audio.sampleRate)

  // beats: vector_real -> number[] (defensive field-name read).
  const rawBeats = (out.beats ?? out.ticks ?? []) as ArrayLike<number>
  const beats = Array.from(rawBeats)
    .map((b) => Number(b))
    .filter((b) => Number.isFinite(b))

  const bpm = Number(out.bpm ?? 0)
  const confidence = Number.isFinite(Number(out.confidence))
    ? Number(out.confidence)
    : 1.0

  // Free the essentia vector we allocated to avoid WASM heap growth across runs.
  try {
    essentia.deleteVector?.(signalVector)
  } catch {
    /* best effort */
  }

  return { bpm, beats, confidence }
}
