import type { DetectResult } from '../types/local'

/** Main → worker: run beat detection (precise tracker, grid-only fallback) on decoded PCM. */
export interface DetectRequest {
  type: 'detect'
  taskId: string
  pcm: Float32Array
  sampleRate: number
  duration: number
}

/** Worker → main: detection result or failure. */
export type DetectResponse =
  | { type: 'result'; taskId: string; result: DetectResult }
  | { type: 'error'; taskId: string; message: string }
