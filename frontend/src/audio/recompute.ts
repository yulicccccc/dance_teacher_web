import type { RecomputeRequest } from '../types/api'
import type { DetectResult } from '../types/local'
import { generateFixedBeats, generateFromFirstBeat } from './segmenter'
import { BPM_MIN, BPM_MAX, DEFAULT_BPM } from './constants'

export interface RecomputeCtx {
  duration: number
  bpm: number
  /** Only needed for the `auto` mode; supplied by the Worker-side caller. */
  redetect?: () => Promise<DetectResult>
}

/**
 * Local equivalent of backend TaskManager.recompute — four modes:
 *  - fixed120: uniform 120 BPM grid, confidence 1.0
 *  - fixedBpm: uniform grid at req.bpm (validated 40-300), confidence 1.0
 *  - manual_first_beat: grid anchored at req.firstBeatTime, bpm unchanged
 *  - auto: delegate to ctx.redetect() (Worker holds the decoded PCM)
 * Returns beatTimes + bpm + confidence (segmenting is done by the caller via
 * segmentBeats). Segment-level fields (beatLowConfidence=false) are applied by
 * the caller's buildResult step.
 */
export async function recomputeLocal(
  req: RecomputeRequest,
  ctx: RecomputeCtx,
): Promise<{ beatTimes: number[]; bpm: number; confidence: number }> {
  switch (req.mode) {
    case 'fixed120': {
      const beatTimes = generateFixedBeats(ctx.duration, 120)
      return { beatTimes, bpm: 120, confidence: 1.0 }
    }
    case 'fixedBpm': {
      const bpm = req.bpm
      if (bpm == null || bpm < BPM_MIN || bpm > BPM_MAX) {
        throw new Error('BPM 需在 40–300 之间')
      }
      const beatTimes = generateFixedBeats(ctx.duration, bpm)
      return { beatTimes, bpm, confidence: 1.0 }
    }
    case 'manual_first_beat': {
      const firstBeatTime = req.firstBeatTime
      if (firstBeatTime == null) {
        throw new Error('manual_first_beat 模式需要 firstBeatTime')
      }
      const beatTimes = generateFromFirstBeat(firstBeatTime, ctx.bpm || DEFAULT_BPM, ctx.duration)
      return { beatTimes, bpm: ctx.bpm, confidence: 1.0 }
    }
    case 'auto': {
      if (!ctx.redetect) {
        throw new Error('auto 模式需要 redetect 回调')
      }
      const det = await ctx.redetect()
      return { beatTimes: det.beatTimes, bpm: det.bpm, confidence: det.confidence }
    }
    default: {
      const mode = (req as RecomputeRequest).mode
      throw new Error(`未知 recompute 模式: ${mode}`)
    }
  }
}
