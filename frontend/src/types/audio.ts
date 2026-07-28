/** Raw mono PCM audio produced by the in-browser extractor. */
export interface AudioData {
  /** Mono Float32 samples, each in the range [-1, 1]. */
  samples: Float32Array
  /** Sample rate in Hz — the extractor forces 44100. */
  sampleRate: number
  /** Duration in seconds (samples.length / sampleRate). */
  duration: number
}

/** Result of beat detection (essentia `RhythmExtractor2013`). */
export interface BeatDetectionResult {
  /** Estimated tempo in beats per minute. */
  bpm: number
  /** Beat onset times in seconds, monotonically increasing. */
  beats: number[]
  /** Detection confidence in [0, 1]. */
  confidence: number
}

/** Recompute fallback modes for low-confidence segmentations. */
export type BeatRecomputeMode = 'auto' | 'fixed120' | 'manual_first_beat'
