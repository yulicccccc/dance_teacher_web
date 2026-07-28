// Local, browser-only domain types.
//
// The app no longer talks to a backend: audio extraction and beat detection run
// entirely in the browser (ffmpeg.wasm + essentia.js). These types describe the
// analysis result produced locally and consumed by the lesson player — there is
// no server schema to mirror anymore.

export interface Segment {
  index: number // 1-based
  startTime: number // seconds
  endTime: number // seconds
  type: string // dance | intro | break
  beats: number[] // length 8, per-beat timestamps (seconds)
}

/** A custom A→B loop anchored on beat boundaries (拍子级自定义循环). */
export interface ABLoop {
  /** Whether the loop is currently active (drives `useBeatSync`). */
  enabled: boolean
  /** Loop start time on the real video timeline (seconds), aligned to a beat. */
  aTime: number
  /** Loop end time on the real video timeline (seconds), aligned to a beat. */
  bTime: number
  /** Display-only global beat ordinal (1-based) for the A point. */
  aBeat: number
  /** Display-only global beat ordinal (1-based) for the B point. */
  bBeat: number
}

export interface AnalysisResult {
  /** Locally-stable id derived from the video file (also the route param). */
  taskId: string
  videoName: string
  bpm: number
  confidence: number // 0~1
  duration: number // seconds
  createdAt: string // ISO-8601
  segments: Segment[]
  beatLowConfidence?: boolean
}

/** Recompute fallback modes for low-confidence segmentations. */
export type RecomputeMode = 'auto' | 'fixed120' | 'manual_first_beat'
