import type { Segment } from '../types/api'
import type { BeatRecomputeMode } from '../types/audio'
import { buildPhrases } from '../utils/segmentMath'

/** Context needed to re-build the phrase grid during a low-confidence fallback. */
export interface RecomputeContext {
  bpm: number
  beats: number[]
  duration: number
}

/**
 * Build 8-beat phrase segments from detected beats.
 *
 * Delegates the pure grouping math to `segmentMath.buildPhrases` (reused from
 * v0.1) and only adapts the `BeatDetectionResult` -> `Segment[]` boundary, so
 * the phrase grid stays identical to what `resegmentSegments` and `useBeatSync`
 * expect downstream.
 */
export function segmentPhrases(beats: number[], duration: number): Segment[] {
  return buildPhrases(beats, duration)
}

/**
 * Low-confidence fallback. Rebuilds the 8-beat grid using one of three modes
 * (see architecture §5.2):
 *  - `auto`             : re-run the default grouping from the detected beats.
 *  - `fixed120`         : a fixed 120 BPM grid from t=0 (ignores detected tempo).
 *  - `manual_first_beat`: a fixed grid starting at the user-supplied first beat.
 */
export function recompute(
  mode: BeatRecomputeMode,
  ctx: RecomputeContext,
  firstBeatTime?: number,
): Segment[] {
  switch (mode) {
    case 'fixed120': {
      const start = firstBeatTime ?? 0
      const beats = gridBeats(start, ctx.duration, 60 / 120)
      return buildPhrases(beats, ctx.duration)
    }
    case 'manual_first_beat': {
      const start =
        typeof firstBeatTime === 'number' && Number.isFinite(firstBeatTime)
          ? firstBeatTime
          : ctx.beats[0] ?? 0
      const beatDur = ctx.bpm > 0 ? 60 / ctx.bpm : 0.5
      const beats = gridBeats(start, ctx.duration, beatDur)
      return buildPhrases(beats, ctx.duration)
    }
    case 'auto':
    default:
      return buildPhrases(ctx.beats, ctx.duration)
  }
}

/** Build a uniform beat grid from `start` to `duration` at `beatDur` seconds. */
function gridBeats(start: number, duration: number, beatDur: number): number[] {
  const beats: number[] = []
  if (!(beatDur > 0)) return beats
  for (let t = start; t < duration; t += beatDur) beats.push(t)
  return beats
}
