import { describe, expect, it } from 'vitest'
import {
  buildMetronomeMidpoints,
  crossedMetronomeMidpoint,
  shouldPlayMetronomeBoundary,
} from '../src/audio/metronomeTiming'
import type { Segment } from '../src/types/api'

const segments: Segment[] = [
  {
    index: 1,
    startTime: 0,
    endTime: 4,
    type: 'dance',
    beats: [0, 0.5, 1, 1.5, 2, 2.5, 3, 3.5],
  },
  {
    index: 2,
    startTime: 4,
    endTime: 5,
    type: 'dance',
    beats: [4, 4.5],
  },
]

describe('metronome tempo modes', () => {
  it('plays half-time only on dance counts 1, 3, 5 and 7', () => {
    expect(
      Array.from({ length: 8 }, (_, index) =>
        shouldPlayMetronomeBoundary(index + 1, 'half'),
      ),
    ).toEqual([true, false, true, false, true, false, true, false])
  })

  it('keeps every detected beat in normal and double-time modes', () => {
    for (let beat = 1; beat <= 8; beat += 1) {
      expect(shouldPlayMetronomeBoundary(beat, 'normal')).toBe(true)
      expect(shouldPlayMetronomeBoundary(beat, 'double')).toBe(true)
    }
  })

  it('places double-time clicks halfway between real beat timestamps', () => {
    expect(buildMetronomeMidpoints(segments, 0.5, 5)).toEqual([
      0.25, 0.75, 1.25, 1.75, 2.25, 2.75, 3.25, 3.75, 4.25, 4.75,
    ])
  })

  it('fires only when forward playback crosses a midpoint', () => {
    const midpoints = [0.25, 0.75, 1.25]
    expect(crossedMetronomeMidpoint(midpoints, 0.2, 0.3)).toBe(true)
    expect(crossedMetronomeMidpoint(midpoints, 0.3, 0.7)).toBe(false)
    expect(crossedMetronomeMidpoint(midpoints, 1.3, 0.2)).toBe(false)
  })
})
