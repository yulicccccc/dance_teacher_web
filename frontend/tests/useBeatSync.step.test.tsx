import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createRef, type RefObject } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react'
import { useBeatSync } from '../src/hooks/useBeatSync'
import type { Segment } from '../src/types/api'

// Flag the React act() environment so state updates inside rAF flush correctly.
;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

// ---- rAF control: capture the single callback so we can step frames manually.
// (Harness copied from tests/useBeatSync.test.tsx to stay compatible with the
// engine's rAF loop, extended with a `paused` flag on the mock video so the
// stepBeat "pause & freeze" behavior can be asserted.)
type RafCb = (t: number) => void
let rafQueue: RafCb[] = []
// `seeked` events queued by the video's `currentTime` setter while a rAF tick
// is running (i.e. the engine's own programmatic loop-back seek). Flushed by
// `flushSeeked()` after the frame, mimicking a real <video> firing `seeked`
// once the seek completes.
let pendingSeeked: Array<() => void> = []
// True only while a rAF tick callback is executing, so the `currentTime` setter
// can tell an engine-driven programmatic seek from a test-driven playback set.
let inFrame = false
const realRaf = globalThis.requestAnimationFrame
const realCaf = globalThis.cancelAnimationFrame
beforeEach(() => {
  rafQueue = []
  pendingSeeked = []
  inFrame = false
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
  inFrame = true
  for (const cb of cbs) cb()
  inFrame = false
}
// Run one animation frame inside act() so React state updates are flushed.
function frame() {
  act(() => {
    flushRaf()
  })
}
// Flush any `seeked` events queued by the engine's programmatic seeks during
// the last frame.
function flushSeeked() {
  act(() => {
    const evs = pendingSeeked
    pendingSeeked = []
    for (const e of evs) e()
  })
}
// Default step used by most tests: run a frame then flush its queued seeked.
function step() {
  frame()
  flushSeeked()
}

// 2 contiguous 8-beat segments @ 120 BPM (0.5s/beat), 4s each:
//   seg 1 beats: 0.0 0.5 1.0 1.5 2.0 2.5 3.0 3.5
//   seg 2 beats: 4.0 4.5 5.0 5.5 6.0 6.5 7.0 7.5
function makeSegments(): Segment[] {
  return Array.from({ length: 2 }, (_, i) => {
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

let last: {
  beatIndex: number
  pulse: boolean
  activeSegment: number
  stepBeat: (dir: 1 | -1) => void
} | null = null
interface Props {
  videoRef: RefObject<HTMLVideoElement>
  segments: Segment[]
  loop: boolean
  offset: number
  beatDuration: number
}
function Harness(props: Props) {
  last = useBeatSync(props.videoRef, props.segments, props.loop, props.offset, props.beatDuration)
  return null
}

// jsdom clamps currentTime on an unloaded <video>, so we back it with a plain
// variable and record every assignment in `timeLog`. `pause()` sets
// `paused = true` (and `play()` clears it) so stepBeat's freeze is observable.
function makeVideo() {
  let current = 0
  let paused = true
  const timeLog: number[] = []
  const video = document.createElement('video') as HTMLVideoElement & { __timeLog: number[] }
  Object.defineProperty(video, 'currentTime', {
    configurable: true,
    get: () => current,
    set: (v: number) => {
      current = v
      timeLog.push(v)
      if (inFrame) {
        pendingSeeked.push(() => video.dispatchEvent(new Event('seeked')))
      }
    },
  })
  Object.defineProperty(video, 'paused', {
    configurable: true,
    get: () => paused,
  })
  video.__timeLog = timeLog
  video.play = vi.fn(() => {
    paused = false
    return Promise.resolve()
  }) as unknown as HTMLMediaElement['play']
  video.pause = vi.fn(() => {
    paused = true
  }) as unknown as HTMLMediaElement['pause']
  return { video, timeLog }
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

describe('stepBeat: 双击跳到相邻拍并暂停定格', () => {
  it('t=0 时 stepBeat(1) 跳到第一个大于 0 的拍点 (0.5) 并暂停', () => {
    const { video, root, container } = setup({
      segments: makeSegments(),
      loop: false,
      offset: 0,
      beatDuration: 0.5,
    })
    // Simulate playing so we can verify pause() actually freezes.
    act(() => {
      void video.play()
    })
    expect(video.paused).toBe(false)

    act(() => {
      last!.stepBeat(1)
    })
    // t=0 sits exactly ON beat[0]=0.0; the strict `> t + EPS` comparison must
    // pick the NEXT beat, 0.5 — not re-select the current one.
    expect(video.currentTime).toBeCloseTo(0.5, 5)
    expect(video.paused).toBe(true)
    expect(video.pause).toHaveBeenCalledTimes(1)
    root.unmount()
    container.remove()
  })

  it('从某拍之前 stepBeat(1) 跳到该拍；随后 stepBeat(-1) 跳回前一拍，每次都 pause', () => {
    const { video, root, container } = setup({
      segments: makeSegments(),
      loop: false,
      offset: 0,
      beatDuration: 0.5,
    })
    // Place the playhead between beats 1.0 and 1.5.
    act(() => {
      video.currentTime = 1.2
    })
    step()

    act(() => {
      last!.stepBeat(1)
    })
    expect(video.currentTime).toBeCloseTo(1.5, 5)
    expect(video.paused).toBe(true)

    act(() => {
      last!.stepBeat(-1)
    })
    // Strictly BEFORE 1.5 (with EPS), so the previous beat is 1.0.
    expect(video.currentTime).toBeCloseTo(1.0, 5)
    expect(video.paused).toBe(true)
    expect(video.pause).toHaveBeenCalledTimes(2)
    root.unmount()
    container.remove()
  })

  it('跨小节：t=3.7（第 1 节末拍后）stepBeat(1) 跳到第 2 节首拍 4.0', () => {
    const { video, root, container } = setup({
      segments: makeSegments(),
      loop: false,
      offset: 0,
      beatDuration: 0.5,
    })
    act(() => {
      video.currentTime = 3.7
    })
    step()

    act(() => {
      last!.stepBeat(1)
    })
    expect(video.currentTime).toBeCloseTo(4.0, 5)
    expect(video.paused).toBe(true)
    root.unmount()
    container.remove()
  })

  it('边界：t=0（首个拍点上）stepBeat(-1) 夹到第一拍 0.0，不越界为负', () => {
    const { video, root, container } = setup({
      segments: makeSegments(),
      loop: false,
      offset: 0,
      beatDuration: 0.5,
    })
    expect(video.currentTime).toBe(0)

    act(() => {
      last!.stepBeat(-1)
    })
    expect(video.currentTime).toBeCloseTo(0.0, 5)
    expect(video.currentTime).toBeGreaterThanOrEqual(0)
    expect(video.paused).toBe(true)
    expect(video.pause).toHaveBeenCalledTimes(1)
    root.unmount()
    container.remove()
  })

  it('边界：t=9.0（超过最后拍点 7.5）stepBeat(1) 夹到最后一拍 7.5', () => {
    const { video, root, container } = setup({
      segments: makeSegments(),
      loop: false,
      offset: 0,
      beatDuration: 0.5,
    })
    act(() => {
      video.currentTime = 9.0
    })
    step()

    act(() => {
      last!.stepBeat(1)
    })
    expect(video.currentTime).toBeCloseTo(7.5, 5)
    expect(video.paused).toBe(true)
    expect(video.pause).toHaveBeenCalledTimes(1)
    root.unmount()
    container.remove()
  })

  it('每次 stepBeat 调用都触发 video.pause()（定格），连续调用累计计数', () => {
    const { video, root, container } = setup({
      segments: makeSegments(),
      loop: false,
      offset: 0,
      beatDuration: 0.5,
    })
    // Three consecutive forward steps from t=0: 0.5 -> 1.0 -> 1.5.
    for (const expected of [0.5, 1.0, 1.5]) {
      act(() => {
        last!.stepBeat(1)
      })
      expect(video.currentTime).toBeCloseTo(expected, 5)
      expect(video.paused).toBe(true)
    }
    expect(video.pause).toHaveBeenCalledTimes(3)
    root.unmount()
    container.remove()
  })

  it('空 segments 时 stepBeat 安全 no-op：不改 currentTime、不调用 pause', () => {
    const { video, root, container } = setup({
      segments: [],
      loop: false,
      offset: 0,
      beatDuration: 0.5,
    })
    act(() => {
      last!.stepBeat(1)
    })
    expect(video.currentTime).toBe(0)
    expect(video.pause).not.toHaveBeenCalled()
    root.unmount()
    container.remove()
  })
})
