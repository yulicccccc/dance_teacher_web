import { describe, expect, it } from 'vitest'
import { buildDemoResult, DEMO_VIDEO_URL } from '../src/demo/sampleLesson'

describe('bundled sample lesson', () => {
  it('uses a same-origin video and builds repeatable 8-count segments', () => {
    const result = buildDemoResult()
    expect(DEMO_VIDEO_URL).toBe('/demo.mp4')
    expect(result.bpm).toBe(100)
    expect(result.segments).toHaveLength(6)
    expect(result.segments.every((segment) => segment.beats.length === 8)).toBe(true)
  })

  it('recomputes the demo grid at a manually supplied BPM', () => {
    const result = buildDemoResult(120)
    expect(result.bpm).toBe(120)
    expect(result.segments).toHaveLength(7)
    expect(result.segments[1].startTime).toBe(4)
  })
})
