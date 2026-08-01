// QA independent regression test. Authored by QA (Edward) — NOT derived from the
// engineer's resegment.test.ts. Imports the REAL shipped function and asserts
// hand-computed expected grids for the exact bug scenario.
import { describe, it, expect } from 'vitest'
import { resegmentSegments } from '../src/utils/segmentMath'
import { locateBeat } from '../src/hooks/useBeatSync'
import type { Segment } from '../src/types/api'

// 16-beat grid @0.5s/beat, 2 phrases (per the bug-repro brief).
function grid16(): Segment[] {
  return [
    { index: 1, startTime: 0, endTime: 4, type: 'dance', beats: [0, 0.5, 1.0, 1.5, 2.0, 2.5, 3.0, 3.5] },
    { index: 2, startTime: 4, endTime: 8, type: 'dance', beats: [4.0, 4.5, 5.0, 5.5, 6.0, 6.5, 7.0, 7.5] },
  ]
}

// 40-beat grid (5 phrases) matching the engineer's repro grid.
function grid40(): Segment[] {
  return Array.from({ length: 5 }, (_, i) => {
    const start = i * 4
    return {
      index: i + 1,
      startTime: start,
      endTime: start + 4,
      type: 'dance',
      beats: Array.from({ length: 8 }, (_, k) => start + k * 0.5),
    }
  })
}

describe('QA-independent: offset = -4 re-cuts to clean 1..8 phrases', () => {
  it('segment 1 beats = original #5..#12 = [2.0..5.5], segment 2 partial (4 beats)', () => {
    const out = resegmentSegments(grid16(), -4)
    // 16 beats, startIndex=4 → 2 segments (base=4: 8 beats, base=12: 4 beats)
    expect(out.length).toBe(2)
    expect(out[0].beats).toEqual([2.0, 2.5, 3.0, 3.5, 4.0, 4.5, 5.0, 5.5])
    expect(out[1].beats.length).toBe(4)
  })

  it('the new phrase start (t=2.0) now reads beatIndex 1 — bug fixed', () => {
    const out = resegmentSegments(grid16(), -4)
    // t=2.0 used to be displayed "5" on the original grid; on the shifted grid
    // it must be beat 1 of the new phrase.
    expect(locateBeat(out, 2.0, 1.9)).toMatchObject({ activeSegment: 1, beatIndex: 1 })
  })

  it('40-beat grid: 5 phrases (last partial), phrase1 start t=2.0 beatIndex 1', () => {
    const out = resegmentSegments(grid40(), -4)
    // 40 beats, startIndex=4 → 5 segments (bases 4,12,20,28,36; last has 4 beats)
    expect(out.length).toBe(5)
    expect(out[0].startTime).toBeCloseTo(2.0, 6)
    expect(locateBeat(out, 2.0, 1.9)).toMatchObject({ activeSegment: 1, beatIndex: 1 })
    expect(locateBeat(out, 5.5, 5.4)).toMatchObject({ activeSegment: 1, beatIndex: 8 })
    expect(locateBeat(out, 6.0, 5.9)).toMatchObject({ activeSegment: 2, beatIndex: 1 })
    // Last segment is partial but present
    expect(out[out.length - 1].beats.length).toBe(4)
  })
})

describe('QA-independent: offset = +2 produces 2 segments from 16-beat grid', () => {
  it('segment 1 has 8 beats [1.0..4.5], segment 2 is partial (6 beats)', () => {
    const out = resegmentSegments(grid16(), 2)
    // 16 beats, startIndex=2 → 2 segments (base=2: 8 beats, base=10: 6 beats)
    expect(out.length).toBe(2)
    expect(out[0].beats).toEqual([1.0, 1.5, 2.0, 2.5, 3.0, 3.5, 4.0, 4.5])
    expect(out[1].beats.length).toBe(6)
  })

  it('phrase start t=1.0 reads beatIndex 1', () => {
    const out = resegmentSegments(grid16(), 2)
    expect(locateBeat(out, 1.0, 0.9)).toMatchObject({ activeSegment: 1, beatIndex: 1 })
  })
})

describe('QA-independent: offset = 0 is equivalent to original grid', () => {
  it('returns the same count and beat times (identity)', () => {
    const segs = grid16()
    const out = resegmentSegments(segs, 0)
    expect(out.length).toBe(segs.length)
    expect(out[0].beats).toEqual(segs[0].beats)
    expect(out[1].beats).toEqual(segs[1].beats)
    expect(out[0].type).toBe('dance')
  })
})

describe('QA-independent: short inputs produce short segments (not dropped)', () => {
  it('empty input returns empty', () => {
    expect(resegmentSegments([], -4)).toEqual([])
  })

  it('fewer than 8 beats produces one short segment instead of being dropped', () => {
    const tiny = [{ index: 1, startTime: 0, endTime: 1.5, type: 'dance', beats: [0, 0.5, 1.0] }]
    const out = resegmentSegments(tiny, 0)
    expect(out.length).toBe(1)
    expect(out[0].beats.length).toBe(3)
  })
})
