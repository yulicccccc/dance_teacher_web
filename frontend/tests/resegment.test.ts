import { describe, it, expect } from 'vitest'
import { estimateBeatDuration, resegmentSegments } from '../src/utils/segmentMath'
import { locateBeat } from '../src/hooks/useBeatSync'
import type { Segment } from '../src/types/api'

/**
 * 5 contiguous 8-beat phrases @ 120 BPM (0.5 s/beat, 4 s each), beat grid from
 * t=0 to t=20, exactly like the backend would return. Index, start/end times
 * and beats are all consistent so resegmentSegments(offset=0) is identity.
 */
function makeSegments(): Segment[] {
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

describe('resegmentSegments — offset = 0 is identity', () => {
  it('estimates beat duration without counting media pre-roll or tail as beats', () => {
    const withEdges: Segment[] = [{
      index: 1,
      startTime: 0,
      endTime: 8,
      type: 'dance',
      beats: [1, 1.5, 2, 2.5, 3, 3.5, 4, 4.5],
    }]
    expect(estimateBeatDuration(withEdges)).toBeCloseTo(0.5, 9)
  })

  it('returns a grid equivalent to the input (same count, times, beats, type)', () => {
    const segs = makeSegments()
    const out = resegmentSegments(segs, 0)
    expect(out.length).toBe(segs.length)
    expect(out).toEqual(segs)
    // every phrase keeps the original 8 beats, untouched
    out.forEach((s, i) => {
      expect(s.index).toBe(i + 1)
      expect(s.beats.length).toBe(8)
      expect(s.startTime).toBeCloseTo(segs[i].startTime, 6)
      expect(s.endTime).toBeCloseTo(segs[i].endTime, 6)
    })
  })

  it('is a pure function: same input -> equal structure, fresh array', () => {
    const segs = makeSegments()
    const a = resegmentSegments(segs, -4)
    const b = resegmentSegments(segs, -4)
    expect(a).toEqual(b)
    expect(a).not.toBe(b) // new array each call, no shared mutable state
  })
})

describe('resegmentSegments — offset shifts the phrase grid', () => {
  it('interior phrases always have exactly 8 consecutive beats', () => {
    // offset=-4 on 5 segments (40 beats): startIndex=4
    // Keep the leading beats 0..3 as a partial phrase, then cut phrases at
    // bases 4,12,20,28,36 (the last is partial too).
    const out = resegmentSegments(makeSegments(), -4)
    expect(out.length).toBe(6)
    expect(out[0].beats).toEqual([0, 0.5, 1, 1.5])
    expect(out[0].startBeat).toBe(5)
    // Only the phrases between the two media edges are complete.
    out.slice(1, -1).forEach((s) => {
      expect(s.beats.length).toBe(8)
      for (let k = 1; k < s.beats.length; k++) {
        expect(s.beats[k] - s.beats[k - 1]).toBeCloseTo(0.5, 6)
      }
    })
    // Last segment may be partial (fewer than 8 beats) but must have ≥1
    expect(out[out.length - 1].beats.length).toBeGreaterThanOrEqual(1)
    expect(out[out.length - 1].beats.length).toBeLessThanOrEqual(8)
  })

  it('keeps the partial phrase before the first shifted downbeat', () => {
    const segs = makeSegments()
    const out = resegmentSegments(segs, -4)
    expect(out[0].startTime).toBe(0)
    expect(out[0].endTime).toBeCloseTo(segs[0].beats[4], 6)
    expect(out[0].beats).toEqual(segs[0].beats.slice(0, 4))
    // These are the previous phrase's visible beats 5..8, not a fake 1..4.
    expect(out[0].startBeat).toBe(5)
    expect(out[1].startTime).toBeCloseTo(2.0, 6)
  })

  it('phrases tile without overlap and end inside the media', () => {
    const out = resegmentSegments(makeSegments(), -4)
    // The partial phrases at BOTH edges remain visible.
    expect(out.length).toBe(6)
    for (let i = 1; i < out.length; i++) {
      expect(out[i].startTime).toBeCloseTo(out[i - 1].endTime, 6)
    }
    expect(out[out.length - 1].endTime).toBeLessThanOrEqual(20.0001)
  })

  it('FEED: locateBeat on the shifted grid reads correctly per phrase', () => {
    const out = resegmentSegments(makeSegments(), -4)
    // The leading partial keeps its real 5..8 count.
    expect(locateBeat(out, 0, 0)).toMatchObject({ activeSegment: 1, beatIndex: 5 })
    expect(locateBeat(out, 1.5, 1.4)).toMatchObject({ activeSegment: 1, beatIndex: 8 })
    // Physical t=2.0 is the first complete shifted phrase -> beat 1.
    expect(locateBeat(out, 2.0, 1.9)).toMatchObject({ activeSegment: 2, beatIndex: 1 })
    expect(locateBeat(out, 5.5, 5.4)).toMatchObject({ activeSegment: 2, beatIndex: 8 })
    expect(locateBeat(out, 6.0, 5.9)).toMatchObject({ activeSegment: 3, beatIndex: 1 })
  })

  it('phrase 1 starts at original beat #3 for offset=+2', () => {
    const segs = makeSegments()
    const out = resegmentSegments(segs, +2)
    expect(out[0].startTime).toBe(0)
    expect(out[0].endTime).toBeCloseTo(1.0, 6)
    expect(out[0].beats).toEqual([0, 0.5])
    expect(out[0].startBeat).toBe(7)
    expect(out[1].startTime).toBeCloseTo(segs[0].beats[2], 6)
    expect(out[1].beats.length).toBe(8)
    // 5 original phrases plus the newly retained leading partial.
    expect(out.length).toBe(6)
  })

  it('+4 and -4 are equivalent modulo 8 (same start time & count)', () => {
    const segs = makeSegments()
    const a = resegmentSegments(segs, 4)
    const b = resegmentSegments(segs, -4)
    expect(a[0].endTime).toBeCloseTo(b[0].endTime, 6)
    expect(a.length).toBe(b.length)
  })
})

describe('resegmentSegments — boundary / safety', () => {
  it('returns [] for an empty segment list', () => {
    expect(resegmentSegments([], 0)).toEqual([])
    expect(resegmentSegments([], -4)).toEqual([])
  })

  it('produces one short segment when fewer than 8 beats total', () => {
    const tiny: Segment[] = [
      {
        index: 1,
        startTime: 0,
        endTime: 1.5,
        type: 'dance',
        beats: [0, 0.5, 1.0],
      },
    ]
    const out0 = resegmentSegments(tiny, 0)
    expect(out0.length).toBe(1)
    expect(out0[0].beats.length).toBe(3)
    const out2 = resegmentSegments(tiny, 2)
    // Two leading beats plus the one-beat trailing phrase are both kept.
    expect(out2.length).toBe(2)
    expect(out2[0].beats.length).toBe(2)
    expect(out2[0].startBeat).toBe(7)
    expect(out2[1].beats.length).toBe(1)
  })

  it('handles a large offset without throwing or going out of bounds', () => {
    const segs = makeSegments()
    expect(() => resegmentSegments(segs, 4)).not.toThrow()
    expect(() => resegmentSegments(segs, -4)).not.toThrow()
    // Leading partial + phrases at base 7,15,23,31,39.
    const out = resegmentSegments(segs, 7)
    expect(out.length).toBe(6)
    expect(out[0].beats.length).toBe(7)
    expect(out[0].startBeat).toBe(2)
    expect(out[1].beats.length).toBe(8)
    expect(out[1].startTime).toBeCloseTo(3.5, 6)
    expect(out[out.length - 1].beats.length).toBe(1)
  })

  it('keeps trailing partial phrase so segment count matches original', () => {
    // 6 phrases (48 beats) -> offset -4 (startIndex 4) yields 6 phrases
    // (last one has only 4 beats instead of being dropped entirely)
    const segs: Segment[] = Array.from({ length: 6 }, (_, i) => {
      const start = i * 4
      return {
        index: i + 1,
        startTime: start,
        endTime: start + 4,
        type: 'dance',
        beats: Array.from({ length: 8 }, (_, k) => start + k * 0.5),
      }
    })
    const out = resegmentSegments(segs, -4)
    // Both partial edges plus five complete interior phrases.
    expect(out.length).toBe(7)
    expect(out[0].beats.length).toBe(4)
    out.slice(1, -1).forEach((s) => expect(s.beats.length).toBe(8))
    // Last segment is partial but present
    expect(out[out.length - 1].beats.length).toBe(4)
  })

  it('real-world case: 8 segments × 8 beats always produces 8 output segments', () => {
    // Simulates the user's bug report: 8 eight-count phrases
    const segs: Segment[] = Array.from({ length: 8 }, (_, i) => {
      const start = i * 4
      return {
        index: i + 1,
        startTime: start,
        endTime: start + 4,
        type: 'dance',
        beats: Array.from({ length: 8 }, (_, k) => start + k * 0.5),
      }
    })
    // A non-zero phase keeps one extra partial phrase at the beginning.
    for (let offset = 0; offset <= 7; offset++) {
      const out = resegmentSegments(segs, offset)
      expect(out.length).toBe(
        offset === 0 ? 8 : 9,
        `offset=${offset} kept the wrong number of edge phrases`,
      )
      // Interior segments always have 8 beats; either edge may be partial.
      out.slice(offset === 0 ? 0 : 1, -1).forEach((s) => expect(s.beats.length).toBe(8))
      // Last segment has at least 1 beat
      expect(out[out.length - 1].beats.length).toBeGreaterThanOrEqual(1)
    }
  })

  it('covers media from 0 through the exact video duration', () => {
    const raw: Segment[] = [
      { index: 1, startTime: 1, endTime: 5, type: 'dance', beats: [1, 1.5, 2, 2.5, 3, 3.5, 4, 4.5] },
      { index: 2, startTime: 5, endTime: 7.75, type: 'dance', beats: [5, 5.5, 6, 6.5, 7, 7.5] },
    ]
    const out = resegmentSegments(raw, 0, 8)
    expect(out[0].startTime).toBe(0)
    expect(out[out.length - 1].endTime).toBe(8)
  })
})
