import type { Segment } from '../types/api'
import { DEFAULT_BPM } from './constants'

/**
 * Split beat timestamps into 8-beat (per default) dance segments.
 * 1:1 port of backend segmenter.aggregate:
 *  - segments[i].startTime = beatTimes[8i]
 *  - segments[i].beats     = beatTimes[8i : 8i+8]
 *  - segments[i].endTime   = beatTimes[8i+8] when a next segment exists
 *  - TAIL (fewer than 8 beats remaining) is still emitted; its endTime =
 *    min(duration, lastBeat + 0.5 * avgInterval), where avgInterval is the
 *    mean spacing within the tail (0.5 when the tail has < 2 beats).
 */
export function segmentBeats(
  beatTimes: number[],
  duration: number,
  beatsPerSegment = 8,
): Segment[] {
  const segs: Segment[] = []
  const n = beatTimes.length
  let i = 0
  while (beatsPerSegment * i < n) {
    const startIdx = beatsPerSegment * i
    const group = beatTimes.slice(startIdx, startIdx + beatsPerSegment)
    const startTime = group[0]
    const nextStartIdx = startIdx + beatsPerSegment
    let endTime: number
    if (nextStartIdx < n) {
      endTime = beatTimes[nextStartIdx]
    } else {
      let avg: number
      if (group.length >= 2) {
        let sum = 0
        for (let k = 1; k < group.length; k++) sum += group[k] - group[k - 1]
        avg = sum / (group.length - 1)
      } else {
        avg = 0.5
      }
      const lastBeat = group[group.length - 1]
      endTime = Math.min(duration, lastBeat + 0.5 * avg)
    }
    segs.push({
      index: i + 1,
      startTime,
      endTime,
      type: 'dance',
      beats: group,
    })
    i++
  }
  return segs
}

/**
 * Generate a uniform beat grid at `bpm` covering [0, duration].
 * `t = i * (60/bpm)`, rounded to 4 decimals; includes beats with t <= duration.
 */
export function generateFixedBeats(duration: number, bpm = DEFAULT_BPM): number[] {
  const step = 60 / bpm
  const count = Math.floor(duration / step) + 1
  const beats: number[] = []
  for (let i = 0; i <= count; i++) {
    const t = i * step
    if (t > duration) break
    beats.push(Number(t.toFixed(4)))
  }
  return beats
}

/**
 * Generate a beat grid anchored at `firstBeatTime` (the 1st beat), spaced by
 * 60/bpm, extending both directions to cover [0, duration]. `bpm` is unchanged.
 */
export function generateFromFirstBeat(
  firstBeatTime: number,
  bpm: number,
  duration: number,
): number[] {
  const step = 60 / bpm
  const kMin = Math.ceil((0 - firstBeatTime) / step)
  const kMax = Math.floor((duration - firstBeatTime) / step)
  const beats: number[] = []
  for (let k = kMin; k <= kMax; k++) {
    beats.push(Number((firstBeatTime + k * step).toFixed(4)))
  }
  return beats
}
