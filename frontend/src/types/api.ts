// Shared wire types — field names mirror the backend JSON (snake_case).
// Keep this file in sync with backend/app/schemas/analysis.py.

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
  taskId: string
  videoName: string
  bpm: number
  confidence: number // 0~1
  duration: number // seconds
  createdAt: string // ISO-8601
  segments: Segment[]
  beatLowConfidence?: boolean
}

export type TaskStatusValue =
  | 'queued'
  | 'extracting'
  | 'beat_detecting'
  | 'segmenting'
  | 'done'
  | 'failed'

export interface TaskStatus {
  taskId: string
  status: TaskStatusValue
  progress: number // 0~100
  result: AnalysisResult | null
  error: string | null
}

export interface UploadResponse {
  taskId: string
  status: string
}

export interface ApiError {
  code: string
  message: string
  data: null
}

export type RecomputeMode = 'auto' | 'fixed120' | 'manual_first_beat'

export interface RecomputeRequest {
  mode: RecomputeMode
  firstBeatTime?: number
}
