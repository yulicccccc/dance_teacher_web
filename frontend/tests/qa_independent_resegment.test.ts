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
  it('offsetSegments[0].beats === original beat #5..#12 = [2.0..5.5]', () => {
    const out = resegmentSegments(grid16(), -4)
    expect(out.length).toBe(1)
    expect(out[0].beats).toEqual([2.0, 2.5, 3.0, 3.5, 4.0, 4.5, 5.0, 5.5])
  })

  it('the new phrase start (t=2.0) now reads beatIndex 1 — bug fixed', () => {
    const out = resegmentSegments(grid16(), -4)
    // t=2.0 used to be displayed "5" on the original grid; on the shifted grid
    // it must be beat 1 of the new phrase.
    expect(locateBeat(out, 2.0, 1.9)).toMatchObject({ activeSegment: 1, beatIndex: 1 })
  })

  it('40-beat grid: 4 phrases, phrase1 start t=2.0 beatIndex 1, phrase2 start t=6.0 beatIndex 1', () => {
    const out = resegmentSegments(grid40(), -4)
    expect(out.length).toBe(4)
    expect(out[0].startTime).toBeCloseTo(2.0, 6)
    expect(locateBeat(out, 2.0, 1.9)).toMatchObject({ activeSegment: 1, beatIndex: 1 })
    expect(locateBeat(out, 5.5, 5.4)).toMatchObject({ activeSegment: 1, beatIndex: 8 })
    expect(locateBeat(out, 6.0, 5.9)).toMatchObject({ activeSegment: 2, beatIndex: 1 })
  })
})

describe('QA-independent: offset = +2 re-cuts to clean 1..8 phrases', () => {
  it('offsetSegments[0].beats === [1.0..4.5]', () => {
    const out = resegmentSegments(grid16(), 2)
    expect(out.length).toBe(1)
    expect(out[0].beats).toEqual([1.0, 1.5, 2.0, 2.5, 3.0, 3.5, 4.0, 4.5])
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

describe('QA-independent: no partial phrases leak through', () => {
  it('requires >=8 total beats; drops leading+trailing partials', () => {
    expect(resegmentSegments([], -4)).toEqual([])
    expect(
      resegmentSegments([{ index: 1, startTime: 0, endTime: 1.5, type: 'dance', beats: [0, 0.5, 1.0] }], 0),
    ).toEqual([])
  })
})
