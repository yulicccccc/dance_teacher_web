// QA-independent tests for the 8-beat segmentation math.
// Authored by QA (Edward) — buildPhrases is the single source of truth for the
// initial 8-beat grid (per architecture §8). segmentPhrases.recompute provides
// the low-confidence fallbacks (auto / fixed120 / manual_first_beat). All pure,
// no browser/WASM needed.
import { describe, it, expect } from 'vitest'
import { buildPhrases } from '../src/utils/segmentMath'
import { segmentPhrases, recompute } from '../src/audio/segmentPhrases'

const DURATION = 8

describe('QA: buildPhrases (single segmentation source)', () => {
  it('groups a clean 8-beat grid into one phrase ending at duration', () => {
    const beats = [0, 0.5, 1, 1.5, 2, 2.5, 3, 3.5]
    const segs = buildPhrases(beats, DURATION)
    expect(segs.length).toBe(1)
    expect(segs[0].startTime).toBe(0)
    expect(segs[0].endTime).toBe(DURATION) // final phrase spans to media end
    expect(segs[0].beats).toEqual(beats)
  })

  it('groups 16 beats into two phrases; interior boundary = next phrase start', () => {
    const beats = Array.from({ length: 16 }, (_, i) => i * 0.5) // 0..7.5
    const segs = buildPhrases(beats, DURATION)
    expect(segs.length).toBe(2)
    expect(segs[0].beats).toEqual(beats.slice(0, 8))
    expect(segs[1].beats).toEqual(beats.slice(8, 16))
    expect(segs[0].endTime).toBeCloseTo(4, 6) // == beats[8]
    expect(segs[1].endTime).toBe(DURATION)
  })

  it('drops a trailing partial phrase (< 8 beats) by default', () => {
    const beats = Array.from({ length: 7 }, (_, i) => i * 0.5)
    expect(buildPhrases(beats, DURATION)).toEqual([])
  })

  it('keeps the partial phrase when dropPartial=false', () => {
    const beats = Array.from({ length: 7 }, (_, i) => i * 0.5)
    const segs = buildPhrases(beats, DURATION, { dropPartial: false })
    expect(segs.length).toBe(1)
    expect(segs[0].beats.length).toBe(7)
  })

  it('supports a custom beatsPerPhrase', () => {
    const beats = [0, 0.5, 1, 1.5, 2, 2.5] // 6 beats -> 2 groups of 3
    const segs = buildPhrases(beats, 3, { beatsPerPhrase: 3 })
    expect(segs.length).toBe(2)
    expect(segs[0].beats).toEqual([0, 0.5, 1])
    expect(segs[1].beats).toEqual([1.5, 2, 2.5])
  })

  it('handles non-uniform beat spacing (groups by count, not intervals)', () => {
    const beats = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15]
    const segs = buildPhrases(beats, 16)
    expect(segs.length).toBe(2)
    expect(segs[1].startTime).toBe(8)
  })

  it('returns [] for empty beats or non-positive duration', () => {
    expect(buildPhrases([], DURATION)).toEqual([])
    expect(buildPhrases([0, 0.5], 0)).toEqual([])
  })

  it('segmentPhrases delegates to buildPhrases', () => {
    const beats = Array.from({ length: 16 }, (_, i) => i * 0.5)
    expect(segmentPhrases(beats, DURATION).length).toBe(2)
  })
})

describe('QA: recompute low-confidence fallbacks', () => {
  const ctx = { bpm: 120, beats: [0, 0.5, 1, 1.5, 2, 2.5, 3, 3.5], duration: DURATION }

  it('auto reuses the detected beats', () => {
    const segs = recompute('auto', ctx)
    expect(segs.length).toBeGreaterThan(0)
    expect(segs[0].beats).toEqual(ctx.beats)
  })

  it('fixed120 builds a 120 BPM grid from t=0', () => {
    const segs = recompute('fixed120', ctx, 0)
    // 120 BPM -> 0.5s beat; 8s -> 16 beats -> 2 phrases.
    expect(segs.length).toBe(2)
    expect(segs[0].beats[0]).toBeCloseTo(0, 6)
    expect(segs[0].beats[1]).toBeCloseTo(0.5, 6)
  })

  it('manual_first_beat starts the fixed grid at the user first beat', () => {
    const segs = recompute('manual_first_beat', ctx, 2)
    // 120 BPM grid from t=2 -> beats 2,2.5,...,7.5 (12 beats). buildPhrases keeps
    // one clean 8-beat phrase [2..5.5] and drops the trailing 4 beats (6..7.5),
    // so the phrase ends at 6.0 rather than the media end.
    expect(segs.length).toBe(1)
    expect(segs[0].startTime).toBeCloseTo(2, 6)
    expect(segs[0].beats[0]).toBeCloseTo(2, 6)
    expect(segs[0].beats.length).toBe(8)
    expect(segs[0].endTime).toBeCloseTo(6, 6)
  })

  it('manual_first_beat falls back to detected first beat when undefined', () => {
    const segs = recompute('manual_first_beat', ctx)
    expect(segs[0].startTime).toBeCloseTo(ctx.beats[0], 6)
  })
})
