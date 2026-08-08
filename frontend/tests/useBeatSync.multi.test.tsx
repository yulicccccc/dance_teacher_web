import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createRef, type RefObject } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react'
import { useBeatSync } from '../src/hooks/useBeatSync'
import type { Segment } from '../src/types/api'

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
// seg1 = [0,4)  padded window [0, 4.5)   -> loopStart 0
// seg3 = [8,12) padded window [7.5, 12.5) -> loopStart 7.5
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
  loopMode: 'single' | 'multi'
  loopSegmentIds: number[]
  active?: boolean
}
function Harness(props: Props) {
  useBeatSync(
    props.videoRef,
    props.segments,
    props.loop,
    props.offset,
    props.beatDuration,
    undefined,
    null,
    null,
    props.loopMode,
    props.loopSegmentIds,
    props.active ?? true,
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

// Advance the playhead in small steps, honouring any loop-back seek.
function drive(
  video: HTMLVideoElement & { __timeLog: number[] },
  timeLog: number[],
  fromT: number,
  frames: number,
  stepSize: number,
  onSeek?: (t: number) => void,
) {
  let position = fromT
  for (let i = 0; i < frames; i++) {
    position = Number((position + stepSize).toFixed(5))
    act(() => {
      video.currentTime = position
    })
    timeLog.length = 0
    step()
    for (const x of timeLog) onSeek?.(x)
    position = (video as unknown as { currentTime: number }).currentTime
  }
}

describe('useBeatSync — multi-segment loop (Part 2)', () => {
  it('cycles through the selected segments, wrapping last back to first', () => {
    // Select [1, 3]. Starting inside seg1, crossing seg1's padded loopEnd (4.5)
    // should seek to seg3's padded start (7.5); crossing seg3's padded loopEnd
    // (12.5) should wrap back to seg1's start (0).
    const { video, timeLog, root, container } = setup({
      segments: makeSegments(),
      loop: true,
      offset: 0,
      beatDuration: 0.5,
      loopMode: 'multi',
      loopSegmentIds: [1, 3],
    })
    act(() => {
      video.currentTime = 1.0
      video.dispatchEvent(new Event('seeked'))
    })
    step()

    let sawSeg3Start = false
    let sawSeg1Start = false
    drive(video, timeLog, 1.0, 4000, 0.01, (x) => {
      if (Math.abs(x - 7.5) < 1e-3) sawSeg3Start = true
      if (Math.abs(x - 0) < 1e-3) sawSeg1Start = true
    })
    expect(sawSeg3Start).toBe(true)
    expect(sawSeg1Start).toBe(true)
    root.unmount()
    container.remove()
  })

  it('empty multi selection degrades to single-segment loop', () => {
    // loopMode 'multi' but no segments ticked -> behaves like single: loops the
    // segment the playhead is in (seg2 -> padded start 3.5), NOT 7.5/0.
    const { video, timeLog, root, container } = setup({
      segments: makeSegments(),
      loop: true,
      offset: 0,
      beatDuration: 0.5,
      loopMode: 'multi',
      loopSegmentIds: [],
    })
    act(() => {
      video.currentTime = 6.0
      video.dispatchEvent(new Event('seeked'))
    })
    step()

    let sawCurrent = false
    let sawMulti = false
    drive(video, timeLog, 6.0, 3000, 0.01, (x) => {
      if (Math.abs(x - 3.5) < 1e-3) sawCurrent = true
      if (Math.abs(x - 7.5) < 1e-3) sawMulti = true
    })
    expect(sawCurrent).toBe(true)
    expect(sawMulti).toBe(false)
    root.unmount()
    container.remove()
  })

  it('manual seek re-anchors the cursor onto the selected segment under the playhead', () => {
    // After looping seg1->seg3, a user seek into the seg1 area should NOT jump
    // to seg3's start on the next frame; the engine waits for the next loopEnd.
    const segs = makeSegments()
    const { video, timeLog, root, container } = setup({
      segments: segs,
      loop: true,
      offset: 0,
      beatDuration: 0.5,
      loopMode: 'multi',
      loopSegmentIds: [1, 3],
    })
    act(() => {
      video.currentTime = 1.0
      video.dispatchEvent(new Event('seeked'))
    })
    step()
    // Get into the multi loop once so a target/cursor exist.
    drive(video, timeLog, 1.0, 2000, 0.01)
    // Manual seek back into seg1.
    act(() => {
      video.currentTime = 2.0
      video.dispatchEvent(new Event('seeked'))
    })
    timeLog.length = 0
    step()
    // Immediately after the manual seek the engine must not have sought to
    // either selected loop start on its own (it waits for the next loopEnd).
    expect(
      timeLog.some((x) => Math.abs(x - 7.5) < 1e-3 || Math.abs(x - 0) < 1e-3),
    ).toBe(false)
    root.unmount()
    container.remove()
  })

  it('inactive (compare-mode) engine issues no loop seek', () => {
    // When `active=false` the engine must only keep prevTime fresh — driving the
    // playhead well past seg1's loopEnd must NOT produce any seek.
    const segs = makeSegments()
    const { video, timeLog, root, container } = setup({
      segments: segs,
      loop: true,
      offset: 0,
      beatDuration: 0.5,
      loopMode: 'single',
      loopSegmentIds: [],
      active: false,
    })
    act(() => {
      video.currentTime = 1.0
      video.dispatchEvent(new Event('seeked'))
    })
    step()
    let sought = false
    drive(video, timeLog, 1.0, 2000, 0.01, (x) => {
      if (timeLog.length > 0) sought = true
    })
    expect(sought).toBe(false)
    root.unmount()
    container.remove()
  })
})
