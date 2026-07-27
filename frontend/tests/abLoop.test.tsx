import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createRef, type RefObject } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react'
import { useBeatSync } from '../src/hooks/useBeatSync'
import { findBeatAt } from '../src/utils/segmentMath'
import type { Segment, ABLoop } from '../src/types/api'

// Flag the React act() environment so state updates inside rAF flush correctly.
;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

// ---- rAF control: capture the single callback so we can step frames manually.
type RafCb = (t: number) => void
let rafQueue: RafCb[] = []
const realRaf = globalThis.requestAnimationFrame
const realCaf = globalThis.cancelAnimationFrame
beforeEach(() => {
  rafQueue = []
  globalThis.requestAnimationFrame = ((cb: RafCb) => {
    rafQueue.push(cb)
    return rafQueue.length
  }) as unknown as typeof requestAnimationFrame
  globalThis.cancelAnimationFrame = (() => {}) as typeof cancelAnimationFrame
})
afterEach(() => {
  globalThis.requestAnimationFrame = realRaf
  globalThis.cancelAnimationFrame = realCaf
})
function flushRaf() {
  const cbs = rafQueue
  rafQueue = []
  for (const cb of cbs) cb()
}
function step() {
  act(() => {
    flushRaf()
  })
}

// 5 contiguous 8-beat segments @ 120 BPM (0.5s/beat), 4s each.
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

// jsdom clamps currentTime on an unloaded <video>, so we back it with a plain
// variable and record every assignment in `timeLog` (the loop's seek target is
// the last entry written during a frame).
function makeVideo() {
  let current = 0
  const timeLog: number[] = []
  const video = document.createElement('video') as HTMLVideoElement & { __timeLog: number[] }
  Object.defineProperty(video, 'currentTime', {
    configurable: true,
    get: () => current,
    set: (v: number) => {
      current = v
      timeLog.push(v)
    },
  })
  video.__timeLog = timeLog
  video.play = vi.fn(() => Promise.resolve()) as unknown as HTMLMediaElement['play']
  video.pause = vi.fn() as unknown as HTMLMediaElement['pause']
  return { video, timeLog }
}

interface Props {
  videoRef: RefObject<HTMLVideoElement>
  segments: Segment[]
  loop: boolean
  offset: number
  beatDuration: number
  abLoop: ABLoop | null
}
function Harness(props: Props) {
  useBeatSync(
    props.videoRef,
    props.segments,
    props.loop,
    props.offset,
    props.beatDuration,
    undefined,
    props.abLoop,
  )
  return null
}

function setup(props: Omit<Props, 'videoRef'>) {
  const videoRef = createRef<HTMLVideoElement>()
  const { video, timeLog } = makeVideo()
  videoRef.current = video
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root: Root = createRoot(container)
  act(() => {
    root.render(<Harness {...props} videoRef={videoRef} />)
  })
  return { videoRef, video, timeLog, root, container }
}

describe('findBeatAt — nearest beat <= time (拍子对齐)', () => {
  const segs = makeSegments()
  it('returns the beat at or just before an arbitrary time', () => {
    const hit = findBeatAt(segs, 2.2)
    expect(hit).not.toBeNull()
    expect(hit!.beatTime).toBeCloseTo(2.0)
    expect(hit!.beatInSeg).toBe(5)
    expect(hit!.segIndex).toBe(1)
  })
  it('matches exactly on a beat boundary', () => {
    const hit = findBeatAt(segs, 4.0)
    expect(hit!.beatTime).toBeCloseTo(4.0)
    expect(hit!.segIndex).toBe(2) // 4.0 is the first beat of segment 2
    expect(hit!.beatInSeg).toBe(1)
  })
  it('computes the global beat ordinal across the flattened timeline', () => {
    // t=8.0 is the first beat of segment 3 -> global 8 (seg1) + 8 (seg2) + 1
    const hit = findBeatAt(segs, 8.0)
    expect(hit!.segIndex).toBe(3)
    expect(hit!.beatInSeg).toBe(1)
    expect(hit!.globalBeat).toBe(17)
  })
  it('returns the last beat when time is past everything', () => {
    const hit = findBeatAt(segs, 100)
    expect(hit!.globalBeat).toBe(40)
    expect(hit!.beatTime).toBeCloseTo(19.5)
  })
  it('falls back to the first beat when time precedes every beat (leading gap)', () => {
    const gapped: Segment[] = [
      {
        index: 1,
        startTime: 2,
        endTime: 6,
        type: 'dance',
        beats: [2, 2.5, 3, 3.5, 4, 4.5, 5, 5.5],
      },
    ]
    const hit = findBeatAt(gapped, 1.0)
    expect(hit!.beatTime).toBeCloseTo(2.0)
    expect(hit!.globalBeat).toBe(1)
  })
  it('returns null for empty segments', () => {
    expect(findBeatAt([], 1.0)).toBeNull()
  })
})

describe('useBeatSync — custom A→B loop (priority over single-segment loop)', () => {
  it('seeks back to aTime when the playhead crosses bTime', () => {
    const ab: ABLoop = { enabled: true, aTime: 2.0, bTime: 6.0, aBeat: 5, bBeat: 13 }
    const { video, timeLog, root, container } = setup({
      segments: makeSegments(),
      loop: false,
      offset: 0,
      beatDuration: 0.5,
      abLoop: ab,
    })
    // Navigate inside the loop window (seeked resets prevTimeRef so the jump is
    // not seen as a crossed boundary).
    act(() => {
      video.currentTime = 2.0
      video.dispatchEvent(new Event('seeked'))
    })
    step()
    timeLog.length = 0
    let looped = false
    for (let k = 1; k <= 100 && !looped; k++) {
      const t = Number((2.0 + k * 0.05).toFixed(5))
      timeLog.length = 0
      act(() => {
        video.currentTime = t
      })
      step()
      if (timeLog.some((x) => Math.abs(x - 2.0) < 1e-3)) looped = true
    }
    expect(looped).toBe(true)
    root.unmount()
    container.remove()
  })

  it('does NOT loop when aTime >= bTime (degenerate / disabled)', () => {
    const ab: ABLoop = { enabled: true, aTime: 6.0, bTime: 6.0, aBeat: 13, bBeat: 13 }
    const { video, timeLog, root, container } = setup({
      segments: makeSegments(),
      loop: false,
      offset: 0,
      beatDuration: 0.5,
      abLoop: ab,
    })
    act(() => {
      video.currentTime = 6.0
      video.dispatchEvent(new Event('seeked'))
    })
    step()
    let soughtToA = false
    for (let k = 1; k <= 40; k++) {
      const t = Number((6.0 + k * 0.05).toFixed(5))
      timeLog.length = 0
      act(() => {
        video.currentTime = t
      })
      step()
      if (timeLog.some((x) => Math.abs(x - 6.0) < 1e-3)) soughtToA = true
    }
    expect(soughtToA).toBe(false)
    root.unmount()
    container.remove()
  })

  it('A→B loop takes priority over the single-segment loop even when both are on', () => {
    // In real usage the store makes these two mutually exclusive, but at the
    // hook level AB must win. Crossing bTime (12.0) should seek to aTime (10.0),
    // NOT to a padded single-segment loopStart (e.g. 7.5 for segment 3).
    const ab: ABLoop = { enabled: true, aTime: 10.0, bTime: 12.0, aBeat: 21, bBeat: 25 }
    const { video, timeLog, root, container } = setup({
      segments: makeSegments(),
      loop: true,
      offset: 0,
      beatDuration: 0.5,
      abLoop: ab,
    })
    act(() => {
      video.currentTime = 10.0
      video.dispatchEvent(new Event('seeked'))
    })
    step()
    timeLog.length = 0
    let soughtToA = false
    let cascaded = false
    for (let k = 1; k <= 60 && !soughtToA; k++) {
      const t = Number((10.0 + k * 0.05).toFixed(5))
      timeLog.length = 0
      act(() => {
        video.currentTime = t
      })
      step()
      if (timeLog.some((x) => Math.abs(x - 10.0) < 1e-3)) soughtToA = true
      // A single-segment loop on seg 3 (start 8, padded start 7.5) would seek
      // to 7.5 if it were active; AB must prevent that (no cascade).
      if (timeLog.some((x) => Math.abs(x - 7.5) < 1e-3)) cascaded = true
    }
    expect(soughtToA).toBe(true)
    expect(cascaded).toBe(false)
    root.unmount()
    container.remove()
  })
})
