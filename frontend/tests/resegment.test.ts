import { describe, it, expect } from 'vitest'
import { resegmentSegments } from '../src/utils/segmentMath'
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
    // Phrases at base 4,12,20,28,36 → first 4 have 8 beats, last has 4
    const out = resegmentSegments(makeSegments(), -4)
    expect(out.length).toBe(5)
    // All but the last have exactly 8 beats
    out.slice(0, -1).forEach((s) => {
      expect(s.beats.length).toBe(8)
      for (let k = 1; k < s.beats.length; k++) {
        expect(s.beats[k] - s.beats[k - 1]).toBeCloseTo(0.5, 6)
      }
    })
    // Last segment may be partial (fewer than 8 beats) but must have ≥1
    expect(out[out.length - 1].beats.length).toBeGreaterThanOrEqual(1)
    expect(out[out.length - 1].beats.length).toBeLessThanOrEqual(8)
  })

  it('phrase 1 starts at the original phrase 1 beat #5 (allBeats[4] = 2.0)', () => {
    const segs = makeSegments()
    const out = resegmentSegments(segs, -4)
    // Original phrase 1's 5th beat (0-based index 4) == 2.0 s.
    expect(out[0].startTime).toBeCloseTo(segs[0].beats[4], 6)
    expect(out[0].startTime).toBeCloseTo(2.0, 6)
  })

  it('phrases tile without overlap and end inside the media', () => {
    const out = resegmentSegments(makeSegments(), -4)
    // 5 segments, offset=-4 → still 5 phrases (last one is shorter)
    expect(out.length).toBe(5)
    for (let i = 1; i < out.length; i++) {
      expect(out[i].startTime).toBeCloseTo(out[i - 1].endTime, 6)
    }
    expect(out[out.length - 1].endTime).toBeLessThanOrEqual(20.0001)
  })

  it('FEED: locateBeat on the shifted grid reads correctly per phrase', () => {
    const out = resegmentSegments(makeSegments(), -4)
    // Physical t=2.0 is the start of phrase 1 -> displayed beat 1.
    expect(locateBeat(out, 2.0, 1.9)).toMatchObject({ activeSegment: 1, beatIndex: 1 })
    // Mid phrase 1 -> beat 4.
    expect(locateBeat(out, 3.5, 3.4)).toMatchObject({ activeSegment: 1, beatIndex: 4 })
    // End of phrase 1 -> beat 8.
    expect(locateBeat(out, 5.5, 5.4)).toMatchObject({ activeSegment: 1, beatIndex: 8 })
    // Next phrase starts at t=6.0 -> beat 1 of phrase 2.
    expect(locateBeat(out, 6.0, 5.9)).toMatchObject({ activeSegment: 2, beatIndex: 1 })
  })

  it('phrase 1 starts at original beat #3 for offset=+2', () => {
    const segs = makeSegments()
    const out = resegmentSegments(segs, +2)
    expect(out[0].startTime).toBeCloseTo(segs[0].beats[2], 6)
    expect(out[0].startTime).toBeCloseTo(1.0, 6)
    expect(out[0].beats.length).toBe(8)
    // 5 segments, offset=+2 → 5 phrases (last partial)
    expect(out.length).toBe(5)
  })

  it('+4 and -4 are equivalent modulo 8 (same start time & count)', () => {
    const segs = makeSegments()
    const a = resegmentSegments(segs, 4)
    const b = resegmentSegments(segs, -4)
    expect(a[0].startTime).toBeCloseTo(b[0].startTime, 6)
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
    // offset=2, startIndex=2, only 1 beat available → still 1 segment
    expect(out2.length).toBe(1)
    expect(out2[0].beats.length).toBe(1)
  })

  it('handles a large offset without throwing or going out of bounds', () => {
    const segs = makeSegments()
    expect(() => resegmentSegments(segs, 4)).not.toThrow()
    expect(() => resegmentSegments(segs, -4)).not.toThrow()
    // 40 beats, startIndex = ((7%8)+8)%8 = 7 -> phrases at base 7,15,23,31,39
    // → 5 phrases (last has only 1 beat)
    const out = resegmentSegments(segs, 7)
    expect(out.length).toBe(5)
    expect(out[0].beats.length).toBe(8)
    expect(out[0].startTime).toBeCloseTo(3.5, 6)
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
    // Must preserve all 6 original segments (last may be short)
    expect(out.length).toBe(6)
    // First 5 are clean 8-beat phrases
    out.slice(0, -1).forEach((s) => expect(s.beats.length).toBe(8))
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
    // Every offset from 0-7 must yield exactly 8 segments
    for (let offset = 0; offset <= 7; offset++) {
      const out = resegmentSegments(segs, offset)
      expect(out.length).toBe(
        8,
        `offset=${offset} expected 8 segments but got ${out.length}`,
      )
      // Interior segments always have 8 beats
      out.slice(0, -1).forEach((s) => expect(s.beats.length).toBe(8))
      // Last segment has at least 1 beat
      expect(out[out.length - 1].beats.length).toBeGreaterThanOrEqual(1)
    }
  })
})
