// Local (browser-only) types. These are NEW types for the client-side
// analysis pipeline and must NOT alter the wire contract in ./api.ts.

/** Decoded mono PCM from a video/audio file. */
export interface DecodedAudio {
  pcm: Float32Array
  sampleRate: number
  duration: number
}

/**
 * Output of an L2 raw beat detector.
 * `rawBeats` is null when the detector does not provide a tracked grid
 * (e.g. the grid-only ACF seed path), which degrades the grid-vs-raw
 * arbitration to "always use uniform grid".
 */
export interface RawTrackResult {
  rawBeats: number[] | null
  tempo: number
  periodSeed: number
}

/** Result of a full local beat detection pass. */
export interface DetectResult {
  bpm: number
  confidence: number
  beatTimes: number[]
  duration: number
  usedGrid: boolean
  engine: 'beat-detection' | 'grid-only'
}
