import type { AnalysisResult } from '../types/api'
import { segmentBeats } from './segmenter'
import { LOW_CONFIDENCE_THRESHOLD } from './constants'

export interface BuildResultInput {
  taskId: string
  videoName: string
  bpm: number
  confidence: number
  duration: number
  beatTimes: number[]
  /** When true, force beatLowConfidence=false (used by fixed* modes). */
  forceConfident?: boolean
}

/**
 * Assemble a local AnalysisResult from detection output.
 * Mirrors backend AnalysisTask.to_result: bpm rounded to 2 decimals,
 * beatLowConfidence = confidence < threshold (unless forced), segments
 * produced by segmentBeats.
 */
export function buildResult(a: BuildResultInput): AnalysisResult {
  const bpm = Number(a.bpm.toFixed(2))
  const beatLowConfidence = a.forceConfident ? false : a.confidence < LOW_CONFIDENCE_THRESHOLD
  return {
    taskId: a.taskId,
    videoName: a.videoName,
    bpm,
    confidence: a.confidence,
    duration: a.duration,
    createdAt: new Date().toISOString(),
    segments: segmentBeats(a.beatTimes, a.duration),
    beatLowConfidence,
  }
}
