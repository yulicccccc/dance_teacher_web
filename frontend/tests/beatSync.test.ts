import { describe, it, expect } from 'vitest'
import {
  locateBeat,
  computeLoopSegment,
  computePaddedLoopBounds,
  computePaddedLoopBoundsForBlock,
  buildLoopBlocks,
} from '../src/hooks/useBeatSync'
import { findBeatAt, resegmentSegments } from '../src/utils/segmentMath'
import type { Segment } from '../src/types/api'

/** Two 8-beat phrases @ 120 BPM (0.5s interval), matching the backend grid. */
function makeSegments(): Segment[] {
  return [
    {
      index: 1,
      startTime: 0,
      endTime: 4,
      type: 'dance',
      beats: [0, 0.5, 1.0, 1.5, 2.0, 2.5, 3.0, 3.5],
    },
    {
      index: 2,
      startTime: 4,
      endTime: 7.75,
      type: 'dance',
      beats: [4.0, 4.5, 5.0, 5.5, 6.0, 6.5, 7.0, 7.5],
    },
  ]
}

describe('locateBeat — segment + beat positioning', () => {
  it('preserves the real count inside a leading partial phrase', () => {
    const partial: Segment[] = [{
      index: 1,
      startTime: 0,
      endTime: 2,
      type: 'dance',
      beats: [0, 0.5, 1, 1.5],
      startBeat: 5,
    }]
    expect(locateBeat(partial, 0, 0)).toMatchObject({ activeSegment: 1, beatIndex: 5 })
    expect(locateBeat(partial, 1.5, 1.4)).toMatchObject({ activeSegment: 1, beatIndex: 8 })
  })

  it('locates the first segment and beat 1 exactly at t=0', () => {
    const r = locateBeat(makeSegments(), 0, 0)
    expect(r.activeSegment).toBe(1)
    expect(r.beatIndex).toBe(1)
    expect(r.crossed).toBe(false) // prev==cur, no crossing
  })

  it('counts beat 2 at t=0.5 and fires a pulse crossing from prev 0', () => {
    const r = locateBeat(makeSegments(), 0.5, 0)
    expect(r.activeSegment).toBe(1)
    expect(r.beatIndex).toBe(2)
    expect(r.crossed).toBe(true)
  })

  it('stays on beat 1 mid-interval (t=0.25)', () => {
    const r = locateBeat(makeSegments(), 0.25, 0)
    expect(r.beatIndex).toBe(1)
    expect(r.crossed).toBe(false)
  })

  it('counts beat 5 at t=2.0 with a crossing', () => {
    const r = locateBeat(makeSegments(), 2.0, 1.9)
    expect(r.activeSegment).toBe(1)
    expect(r.beatIndex).toBe(5)
    expect(r.crossed).toBe(true)
  })

  it('crosses into the second segment at its first beat (t=4.0)', () => {
    const r = locateBeat(makeSegments(), 4.0, 3.9)
    expect(r.activeSegment).toBe(2)
    expect(r.beatIndex).toBe(1)
    expect(r.crossed).toBe(true)
  })

  it('falls back to the last segment past its endTime (t=7.8)', () => {
    const r = locateBeat(makeSegments(), 7.8, 7.7)
    expect(r.activeSegment).toBe(2)
    // last beat 7.5 is the most recent <= 7.8 -> beat 8
    expect(r.beatIndex).toBe(8)
    expect(r.crossed).toBe(false) // 7.5 was already passed before prev=7.7
  })

  it('returns nothing when there are no segments', () => {
    const r = locateBeat([], 1.0, 0)
    expect(r.activeSegment).toBe(0)
    expect(r.beatIndex).toBe(0)
    expect(r.crossed).toBe(false)
  })
})

describe('locateBeat — pulse (crossing) semantics', () => {
  it('detects multiple beats crossed in a single fast-forward frame', () => {
    // jumping from 0 to 2.0 crosses beats 0.5,1.0,1.5,2.0 -> crossed
    const r = locateBeat(makeSegments(), 2.0, 0)
    expect(r.crossed).toBe(true)
    expect(r.beatIndex).toBe(5)
  })

  it('does NOT fire a phantom pulse on a backward seek', () => {
    // seeked backward: prev 5 -> cur 1.0; no beat satisfies prev < bt <= cur
    const r = locateBeat(makeSegments(), 1.0, 5)
    expect(r.crossed).toBe(false)
    expect(r.beatIndex).toBe(3) // beat 1.0 -> index 3
  })

  it('does NOT fire when paused exactly between frames (prev == cur)', () => {
    const r = locateBeat(makeSegments(), 1.5, 1.5)
    expect(r.crossed).toBe(false)
    expect(r.beatIndex).toBe(4)
  })
})

describe('computeLoopSegment — single-segment loop targets the just-finished segment (Bug A)', () => {
  // Uniform 8-beat segments @ 120 BPM (0.5s/beat): 0-4, 4-8, 8-12, 12-16, 16-20.
  const segs: Segment[] = Array.from({ length: 5 }, (_, i) => {
    const start = i * 4
    return {
      index: i + 1,
      startTime: start,
      endTime: start + 4,
      type: 'dance',
      beats: Array.from({ length: 8 }, (_, k) => start + k * 0.5),
    }
  })

  it('returns the interior segment whose END was crossed this frame', () => {
    // Crossed segment 3's end (12.0) between prev=11.95 and cur=12.0.
    const r = computeLoopSegment(segs, 11.95, 12.0)
    expect(r?.index).toBe(3)
    expect(r?.startTime).toBe(8.0)
  })

  it('returns the LAST segment when its END is crossed (end-of-media fallback)', () => {
    const r = computeLoopSegment(segs, 19.9, 20.0)
    expect(r?.index).toBe(5)
  })

  it('returns null when no segment boundary was crossed', () => {
    expect(computeLoopSegment(segs, 2.0, 2.5)).toBeNull()
  })

  it('returns null on a backward seek (prev > cur)', () => {
    expect(computeLoopSegment(segs, 12.0, 8.0)).toBeNull()
  })

  it('does NOT re-detect the previous boundary right after a loop restart', () => {
    // After looping seg3 we seek to 8.0 and the next frame has prev = 8.0-eps.
    // Crossing into seg2's end (8.0) must NOT be detected, else the loop would
    // cascade backward through the segments. The lower epsilon guard prevents
    // this: seg2.end(8.0) - LOOP_EPS(0.001) = 7.999, and prev(7.999) < 7.999 is
    // false, so seg2 is ignored while seg3's crossed end (12.0) is still found.
    const r = computeLoopSegment(segs, 7.999, 12.05)
    expect(r?.index).toBe(3)
  })
})

/** Uniform 8-beat segments @ 120 BPM (0.5s/beat): 0-4, 4-8, ... */
function makeUniformSegments(count: number, beat = 0.5, segLen = 4): Segment[] {
  return Array.from({ length: count }, (_, i) => {
    const start = i * segLen
    return {
      index: i + 1,
      startTime: start,
      endTime: start + segLen,
      type: 'dance',
      beats: Array.from({ length: 8 }, (_, k) => start + k * beat),
    }
  })
}

describe('computePaddedLoopBounds — 前后各一拍 padding', () => {
  // 5 segments: 0-4, 4-8, 8-12, 12-16, 16-20, 0.5s/beat.
  const segs = makeUniformSegments(5)

  it('interior segment: padded by one beat on both sides', () => {
    // segs[2] is segment index 3, window 8-12.
    const r = computePaddedLoopBounds(segs[2], segs, 0.5)
    expect(r.loopStart).toBeCloseTo(8 - 0.5) // 7.5 (last beat of prev phrase)
    expect(r.loopEnd).toBeCloseTo(12 + 0.5) // 12.5 (first beat of next phrase)
  })

  it('first segment: no lead-in padding (loopStart clamps to startTime)', () => {
    // seg index 1, window 0-4. No previous segment -> loopStart stays at 0.
    const r = computePaddedLoopBounds(segs[0], segs, 0.5)
    expect(r.loopStart).toBe(0)
    expect(r.loopStart).toBeGreaterThanOrEqual(0)
    expect(r.loopEnd).toBeCloseTo(4 + 0.5) // 4.5 (trailing beat still added)
  })

  it('last segment: no trailing padding (loopEnd clamps to endTime)', () => {
    // seg index 5, window 16-20. No next segment -> loopEnd stays at 20.
    const r = computePaddedLoopBounds(segs[4], segs, 0.5)
    expect(r.loopStart).toBeCloseTo(16 - 0.5) // 15.5 (lead-in still added)
    expect(r.loopEnd).toBe(20)
  })

  it('clamps the lead-in at t=0 so it never goes negative', () => {
    const r = computePaddedLoopBounds(segs[0], segs, 10) // absurdly large beat
    expect(r.loopStart).toBe(0)
  })

  it('degrades to raw [startTime, endTime) when beatDuration <= 0', () => {
    // interior segment, beat == 0 -> no padding at all.
    const r = computePaddedLoopBounds(segs[2], segs, 0)
    expect(r.loopStart).toBe(8)
    expect(r.loopEnd).toBe(12)
    const rNeg = computePaddedLoopBounds(segs[2], segs, -1)
    expect(rNeg.loopStart).toBe(8)
    expect(rNeg.loopEnd).toBe(12)
  })

  it('ignores non-finite beatDuration (NaN) and degrades gracefully', () => {
    const r = computePaddedLoopBounds(segs[1], segs, NaN)
    expect(r.loopStart).toBe(4)
    expect(r.loopEnd).toBe(8)
  })

  it('single-segment timeline: no prev/next, raw bounds', () => {
    const single = makeUniformSegments(1)
    const r = computePaddedLoopBounds(single[0], single, 0.5)
    expect(r.loopStart).toBe(0)
    expect(r.loopEnd).toBe(4)
  })

  it('cascade-prevention invariant: lead-in lands inside the PREVIOUS segment', () => {
    // For an interior segment the padded loopStart sits inside the previous
    // phrase, so the loop must rely on a LOCKED target (loopTargetRef) and NOT
    // re-scan boundaries — otherwise seeking back here would re-trigger the
    // previous segment and cascade backward. Assert the invariant holds.
    const r = computePaddedLoopBounds(segs[2], segs, 0.5) // window 8-12, prev 4-8
    expect(r.loopStart).toBeLessThan(segs[2].startTime) // 7.5 < 8
    expect(r.loopStart).toBeGreaterThanOrEqual(segs[1].startTime) // >= 4
  })
})

describe('offset grid — every loop mode shares retained edge phrases', () => {
  it('keeps 0..duration and derives single/multi/AB anchors from the same grid', () => {
    const shifted = resegmentSegments(makeUniformSegments(5), -1, 20)
    // -1 => seven visible counts (2..8) before the first complete new phrase.
    expect(shifted[0]).toMatchObject({
      index: 1,
      startTime: 0,
      endTime: 3.5,
      startBeat: 2,
    })
    expect(shifted[shifted.length - 1].endTime).toBe(20)

    const target = shifted[1] // first complete 1..8 phrase, 3.5..7.5
    expect(computePaddedLoopBounds(target, shifted, 0.5)).toEqual({
      loopStart: 3,
      loopEnd: 8,
    })

    const blocks = buildLoopBlocks(shifted, [1, 2])
    expect(blocks).toHaveLength(1)
    expect(computePaddedLoopBoundsForBlock(blocks[0], shifted, 0.5)).toEqual({
      loopStart: 0,
      loopEnd: 8,
    })

    expect(findBeatAt(shifted, 3)).toMatchObject({
      segIndex: 1,
      beatInSeg: 8,
      beatTime: 3,
    })
    expect(findBeatAt(shifted, 3.5)).toMatchObject({
      segIndex: 2,
      beatInSeg: 1,
      beatTime: 3.5,
    })
  })
})

describe('QA 独立回归 — 循环 padding 边界', () => {
  // 5 segments: 0-4, 4-8, 8-12, 12-16, 16-20, 0.5s/beat.
  const segs = makeUniformSegments(5)

  it('uses the adjacent real beat timestamps instead of an unrelated average duration', () => {
    // Even an absurd global average cannot move the seam away from the actual
    // previous beat 8 / boundary after the next beat 1.
    const r = computePaddedLoopBounds(segs[1], segs, 10)
    expect(r.loopStart).toBe(3.5)
    expect(r.loopStart).toBeGreaterThanOrEqual(0)
    expect(r.loopEnd).toBeCloseTo(8.5)
  })

  it('honours a non-uniform beat grid exactly', () => {
    const irregular = makeUniformSegments(3)
    irregular[0].beats[7] = 3.72
    irregular[2].beats[1] = 8.61
    expect(computePaddedLoopBounds(irregular[1], irregular, 0.5)).toEqual({
      loopStart: 3.72,
      loopEnd: 8.61,
    })
  })

  it('padded bounds sweep: ordered and inside the timeline for every segment', () => {
    // Cross-checks the clamp invariant across all segments (not just the edges):
    // loopStart >= 0, loopEnd <= mediaEnd, and loopEnd > loopStart always.
    const mediaEnd = segs[segs.length - 1].endTime
    for (const s of segs) {
      const r = computePaddedLoopBounds(s, segs, 0.5)
      expect(r.loopStart).toBeGreaterThanOrEqual(0)
      expect(r.loopEnd).toBeLessThanOrEqual(mediaEnd)
      expect(r.loopEnd).toBeGreaterThan(r.loopStart)
    }
  })
})
