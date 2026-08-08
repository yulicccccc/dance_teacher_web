import { describe, it, expect } from 'vitest'
import { segmentBeats, generateFixedBeats, generateFromFirstBeat } from '../src/audio/segmenter'
import { recomputeLocal } from '../src/audio/recompute'
import { buildResult } from '../src/audio/buildResult'

describe('segmentBeats', () => {
  it('splits into 8-beat segments with correct index/times/beats', () => {
    const beatTimes = Array.from({ length: 16 }, (_, i) => Number((i * 0.5).toFixed(4)))
    const segs = segmentBeats(beatTimes, 8)
    expect(segs.length).toBe(2)
    expect(segs[0].index).toBe(1)
    expect(segs[0].startTime).toBe(0)
    expect(segs[0].endTime).toBe(4) // beatTimes[8] = 4.0
    expect(segs[0].beats.length).toBe(8)
    expect(segs[0].type).toBe('dance')
    expect(segs[1].index).toBe(2)
    expect(segs[1].startTime).toBe(4)
    // 2nd group is the tail (no 17th beat) → endTime = min(duration, lastBeat + 0.5*avg)
    // = min(8, 7.5 + 0.25) = 7.75
    expect(segs[1].endTime).toBeCloseTo(7.75, 5)
  })

  it('emits the tail segment even when fewer than 8 beats remain', () => {
    // 17 beats -> 2 full segments + 1 tail of a single beat (avg fallback = 0.5)
    const beatTimes = Array.from({ length: 17 }, (_, i) => Number((i * 0.5).toFixed(4)))
    const segs = segmentBeats(beatTimes, 9)
    expect(segs.length).toBe(3)
    expect(segs[2].index).toBe(3)
    expect(segs[2].beats.length).toBe(1)
    // endTime = min(duration, lastBeat + 0.5 * avg) = min(9, 8.0 + 0.25) = 8.25
    expect(segs[2].endTime).toBeCloseTo(8.25, 5)
  })

  it('returns [] for empty input', () => {
    expect(segmentBeats([], 10)).toEqual([])
  })
})

describe('generateFixedBeats', () => {
  it('produces a uniform grid spaced exactly 0.5s at 120 BPM', () => {
    const beats = generateFixedBeats(4, 120)
    expect(beats[0]).toBe(0)
    expect(beats[1]).toBe(0.5)
    expect(beats[beats.length - 1]).toBeLessThanOrEqual(4)
    for (let i = 1; i < beats.length; i++) {
      expect(Math.abs(beats[i] - beats[i - 1] - 0.5)).toBeLessThan(1e-3)
    }
  })
})

describe('generateFromFirstBeat', () => {
  it('anchors the first beat and covers [0, duration]', () => {
    const beats = generateFromFirstBeat(0.3, 120, 4)
    expect(beats[0]).toBeCloseTo(0.3, 4)
    expect(beats.every((t) => t >= 0 && t <= 4)).toBe(true)
  })
})

describe('recomputeLocal', () => {
  const ctx = { duration: 4, bpm: 100 }

  it('fixed120 returns 120 BPM uniform grid', async () => {
    const r = await recomputeLocal({ mode: 'fixed120' }, ctx)
    expect(r.bpm).toBe(120)
    expect(r.confidence).toBe(1.0)
    expect(r.beatTimes.length).toBeGreaterThan(0)
  })

  it('fixedBpm returns the given bpm', async () => {
    const r = await recomputeLocal({ mode: 'fixedBpm', bpm: 100 }, ctx)
    expect(r.bpm).toBe(100)
    expect(r.confidence).toBe(1.0)
  })

  it('fixedBpm out of range throws', async () => {
    await expect(recomputeLocal({ mode: 'fixedBpm', bpm: 10 }, ctx)).rejects.toThrow(
      'BPM 需在 40–300 之间',
    )
  })

  it('manual_first_beat keeps bpm and anchors the first beat', async () => {
    const r = await recomputeLocal({ mode: 'manual_first_beat', firstBeatTime: 0.3 }, ctx)
    expect(r.bpm).toBe(100)
    expect(r.confidence).toBe(1.0)
    expect(r.beatTimes[0]).toBeCloseTo(0.3, 4)
  })

  it('auto delegates to redetect', async () => {
    const r = await recomputeLocal(
      { mode: 'auto' },
      {
        ...ctx,
        redetect: async () => ({
          bpm: 95,
          confidence: 0.8,
          beatTimes: [0, 0.5, 1],
          duration: 4,
          usedGrid: true,
          engine: 'grid-only',
        }),
      },
    )
    expect(r.bpm).toBe(95)
    expect(r.beatTimes.length).toBe(3)
  })
})

describe('buildResult', () => {
  const base = {
    taskId: 't1',
    videoName: 'v.mp4',
    bpm: 100.12345,
    confidence: 0.9,
    duration: 8,
    beatTimes: Array.from({ length: 16 }, (_, i) => i * 0.5),
  }

  it('rounds bpm to 2 decimals and segments the beats', () => {
    const r = buildResult(base)
    expect(r.bpm).toBe(100.12)
    expect(r.beatLowConfidence).toBe(false)
    expect(r.segments.length).toBe(2)
  })

  it('flags low confidence below threshold', () => {
    const r = buildResult({ ...base, confidence: 0.4, beatTimes: [] })
    expect(r.beatLowConfidence).toBe(true)
  })

  it('forceConfident overrides the threshold', () => {
    const r = buildResult({ ...base, confidence: 0.4, beatTimes: [], forceConfident: true })
    expect(r.beatLowConfidence).toBe(false)
  })
})
