import type { Segment } from '../types/api'

export type MetronomeRate = 'half' | 'normal' | 'double'

/** Half-time follows dance counts 1/3/5/7; the other modes keep every beat. */
export function shouldPlayMetronomeBoundary(
  beat: number,
  rate: MetronomeRate,
): boolean {
  return beat >= 1 && beat <= 8 && (rate !== 'half' || beat % 2 === 1)
}

/**
 * Media-time targets for double-time clicks. Real beat timestamps remain the
 * source of truth, so playback speed, looping and beat-offset changes cannot
 * create a second drifting clock.
 */
export function buildMetronomeMidpoints(
  segments: Segment[],
  fallbackBeatDuration: number,
  duration?: number,
): number[] {
  const beats = segments
    .flatMap((segment) => segment.beats)
    .filter((beat) => Number.isFinite(beat) && beat >= 0)
    .sort((a, b) => a - b)
    .filter((beat, index, all) => index === 0 || Math.abs(beat - all[index - 1]) > 1e-6)
  const midpoints: number[] = []
  for (let index = 0; index + 1 < beats.length; index += 1) {
    midpoints.push((beats[index] + beats[index + 1]) / 2)
  }

  const lastBeat = beats[beats.length - 1]
  const safeBeat =
    Number.isFinite(fallbackBeatDuration) && fallbackBeatDuration > 0
      ? fallbackBeatDuration
      : 0
  const mediaEnd = Number.isFinite(duration) ? Math.max(0, duration as number) : 0
  if (lastBeat != null && safeBeat > 0 && mediaEnd > lastBeat) {
    const finalBoundary = Math.min(mediaEnd, lastBeat + safeBeat)
    if (finalBoundary > lastBeat) midpoints.push((lastBeat + finalBoundary) / 2)
  }
  return midpoints
}

export function crossedMetronomeMidpoint(
  midpoints: number[],
  previousTime: number,
  currentTime: number,
): boolean {
  return (
    currentTime >= previousTime &&
    midpoints.some(
      (midpoint) => previousTime < midpoint && midpoint <= currentTime,
    )
  )
}
