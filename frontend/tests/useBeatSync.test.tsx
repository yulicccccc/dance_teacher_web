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
// Run one animation frame inside act() so React state updates are flushed.
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

let last: { beatIndex: number; pulse: boolean; activeSegment: number } | null = null
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

describe('Bug A: single-segment loop targets the navigated (interior) segment', () => {
  it('navigating to segment 3 then enabling loop restarts (padded) seg 3, not segment 1', () => {
    const { video, timeLog, root, container } = setup({
      segments: makeSegments(),
      loop: true,
      offset: 0,
      beatDuration: 0.5,
    })
    // Navigate to segment 3 (start = 8.0). In the real app goToSegment() calls
    // seek(), whose `seeked` listener resets prevTimeRef so the loop does not
    // see the jump itself as a crossed boundary.
    act(() => {
      video.currentTime = 8.0
      video.dispatchEvent(new Event('seeked'))
    })
    step()
    // Forget the navigate seek; only the loop's own reset target matters.
    timeLog.length = 0
    // Advance in continuous playback steps so only one boundary is crossed per
    // frame. We must play PAST segment 3's end (12.0) into its one-beat
    // trailing buffer (padded loopEnd = 12.5) before the loop restarts — the
    // old behavior restarted exactly at 12.0 and chopped the seam beat off.
    // Iterating by integer index guarantees we reach exactly t=12.5 (k=90)
    // despite float accumulation of 0.05.
    let looped = false
    for (let k = 1; k <= 100 && !looped; k++) {
      const t = Number((8.0 + k * 0.05).toFixed(5))
      act(() => {
        video.currentTime = t
      })
      step()
      // The padded loopStart for interior segment 3 is 7.5 (one beat before its
      // real start of 8.0, landing in the previous phrase's last beat). The
      // cushion seek is the presence of a ~7.5 entry in the time log.
      if (timeLog.some((x) => Math.abs(x - 7.5) < 1e-3)) looped = true
    }
    // The loop restarted the navigated segment 3's PADDED window (loopStart =
    // 7.5) and did NOT fall back to segment 1 (start = 0.0) — the old bug
    // always looped seg 1. This simultaneously proves Bug A (correct target)
    // and that the one-beat lead-in is applied (start shifted to 7.5).
    expect(looped).toBe(true)
    expect(timeLog.some((t) => Math.abs(t - 7.5) < 1e-3)).toBe(true)
    expect(timeLog.some((t) => Math.abs(t - 0.0) < 1e-3)).toBe(false)
    root.unmount()
    container.remove()
  })
})

describe('Bug B: beat offset shifts the displayed count', () => {
  it('offset +1 at t=1.0 (beat 3) shows beat 2', () => {
    const { video, videoRef, root, container } = setup({
      segments: makeSegments(),
      loop: false,
      offset: 0,
      beatDuration: 0.5,
    })
    act(() => {
      video.currentTime = 1.0
    })
    step()
    expect(last?.beatIndex).toBe(3)
    // Change offset to +1, reusing the same videoRef.
    act(() => {
      root.render(<Harness videoRef={videoRef} segments={makeSegments()} loop={false} offset={1} beatDuration={0.5} />)
    })
    act(() => {
      video.currentTime = 1.0
    })
    step()
    expect(last?.beatIndex).toBe(2) // shifted earlier by one beat
    root.unmount()
    container.remove()
  })

  it('offset -1 at t=1.5 (beat 4) shows beat 5', () => {
    const { video, videoRef, root, container } = setup({
      segments: makeSegments(),
      loop: false,
      offset: 0,
      beatDuration: 0.5,
    })
    act(() => {
      video.currentTime = 1.5
    })
    step()
    expect(last?.beatIndex).toBe(4)
    act(() => {
      root.render(<Harness videoRef={videoRef} segments={makeSegments()} loop={false} offset={-1} beatDuration={0.5} />)
    })
    act(() => {
      video.currentTime = 1.5
    })
    step()
    expect(last?.beatIndex).toBe(5)
    root.unmount()
    container.remove()
  })
})

describe('QA 独立回归 — 防级联 (cascade-prevention invariant)', () => {
  it('multi-cycle loop restarts at padded start (7.5) and never cascades to a previous segment', () => {
    const { video, timeLog, root, container } = setup({
      segments: makeSegments(),
      loop: true,
      offset: 0,
      beatDuration: 0.5,
    })
    // Navigate to segment 3 (start = 8.0) and enable the loop.
    act(() => {
      video.currentTime = 8.0
      video.dispatchEvent(new Event('seeked'))
    })
    step()
    timeLog.length = 0

    // Simulate ~30s of continuous playback (padded window is [7.5, 12.5], so one
    // cycle is ~5s -> ~6 cycles). Each frame we advance from the position the
    // loop left us at, so a loop-back seek is honoured (not overwritten by a
    // blind linear ramp). We assert the loop restarts at 7.5 every cycle and
    // NEVER re-triggers segment 2 (start = 4.0) or segment 1 (start = 0.0):
    // that would be the backward cascade the locked target is meant to prevent.
    let position = 8.0
    let restarts = 0
    let soughtToPrev = false
    for (let i = 0; i < 700; i++) {
      timeLog.length = 0
      position += 0.05
      act(() => {
        video.currentTime = position
      })
      step()
      if (timeLog.some((x) => Math.abs(x - 7.5) < 1e-3)) restarts++
      if (timeLog.some((x) => Math.abs(x - 4.0) < 1e-3)) soughtToPrev = true
      if (timeLog.some((x) => Math.abs(x - 0.0) < 1e-3)) soughtToPrev = true
      // Honour any loop-back the engine performed this frame.
      position = (video as unknown as { currentTime: number }).currentTime
    }
    // Multiple clean cycles completed...
    expect(restarts).toBeGreaterThanOrEqual(3)
    // ...with zero cascade into an earlier segment.
    expect(soughtToPrev).toBe(false)
    root.unmount()
    container.remove()
  })
})

describe('QA 独立回归 — 只在跨过扩展后 loopEnd 才重启 (point 4)', () => {
  it('does NOT restart before the padded loopEnd (12.5) — only after crossing it', () => {
    const { video, timeLog, root, container } = setup({
      segments: makeSegments(),
      loop: true,
      offset: 0,
      beatDuration: 0.5,
    })
    act(() => {
      video.currentTime = 8.0
      video.dispatchEvent(new Event('seeked'))
    })
    step()
    timeLog.length = 0

    let restartedEarly = false
    // March from 8.0 upward in 0.05 steps. The OLD (buggy) loopEnd was 12.0;
    // the FIXED padded loopEnd is 12.5. We assert that while the playhead is in
    // (12.0, 12.5) — past the old end but before the padded end — no restart to
    // 7.5 has happened yet. A restart there would mean it used the wrong bound.
    for (let k = 1; k <= 89; k++) {
      const t = Number((8.0 + k * 0.05).toFixed(5))
      timeLog.length = 0
      act(() => {
        video.currentTime = t
      })
      step()
      if (t > 12.0 && t < 12.5 && timeLog.some((x) => Math.abs(x - 7.5) < 1e-3)) {
        restartedEarly = true
      }
    }
    expect(restartedEarly).toBe(false)
    root.unmount()
    container.remove()
  })
})
