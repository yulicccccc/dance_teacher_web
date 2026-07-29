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
// `seeked` events queued by the video's `currentTime` setter while a rAF tick
// is running (i.e. the engine's own programmatic loop-back seek). Flushed by
// `flushSeeked()` after the frame, mimicking a real <video> firing `seeked`
// once the seek completes. Seeks performed OUTSIDE a tick (plain playback
// advances set by the test, or explicit user-drag dispatches) do NOT enqueue,
// because a real browser only fires `seeked` for genuine seeks, not for every
// frame's playback advance.
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
// Does NOT flush the queued `seeked` events (see flushSeeked).
function frame() {
  act(() => {
    flushRaf()
  })
}
// Flush any `seeked` events queued by the engine's programmatic seeks during
// the last frame. This is where the guard flag in useBeatSync gets cleared,
// exactly like a real browser firing `seeked` after the seek lands.
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
      // Replay a real <video>'s `seeked` for engine-driven programmatic seeks
      // (the single-segment/AB loop-back, which runs inside a rAF tick). Plain
      // playback advances set by the test run OUTSIDE a tick and must stay
      // silent, otherwise every per-frame advance would be read as a user drag
      // and re-lock the loop target every frame (breaking the cascade guards).
      if (inFrame) {
        pendingSeeked.push(() => video.dispatchEvent(new Event('seeked')))
      }
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

describe('Bug: user seek while looping re-locks the loop target to the new section', () => {
  it('user drags to segment 5 after looping seg 3 → loop re-locks to seg 5 (restart at 15.5), no cascade to seg 1/2', () => {
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

    // Loop seg 3: confirm it restarts at its padded start 7.5 (one beat before
    // its real 8.0 start, sitting in the previous phrase's last beat).
    let looped3 = false
    for (let k = 1; k <= 100 && !looped3; k++) {
      const t = Number((8.0 + k * 0.05).toFixed(5))
      timeLog.length = 0
      act(() => {
        video.currentTime = t
      })
      step()
      if (timeLog.some((x) => Math.abs(x - 7.5) < 1e-3)) looped3 = true
    }
    expect(looped3).toBe(true)

    // --- User drags the scrubber to segment 5 (start = 16.0, end = 20.0). This
    // is a REAL user seek, NOT the loop's own loop-back seek (which would land at
    // 7.5), so the loop target must re-lock onto segment 5.
    act(() => {
      video.currentTime = 16.0
      video.dispatchEvent(new Event('seeked'))
    })
    timeLog.length = 0

    // Continue playback from ~16.0. Assert we eventually restart at seg 5's
    // padded start 15.5 (= 16.0 - 0.5, one beat before its real start, sitting in
    // the previous phrase's last beat) and that the OLD seg-3 start (7.5) and any
    // earlier-segment starts (4.0 / 0.0) NEVER recur — i.e. no backward cascade.
    let position = 16.0
    let restartedAt15_5 = false
    let reappeared7_5 = false
    let cascadeToPrev = false
    for (let i = 0; i < 700; i++) {
      timeLog.length = 0
      position += 0.05
      act(() => {
        video.currentTime = position
      })
      step()
      if (timeLog.some((x) => Math.abs(x - 15.5) < 1e-3)) restartedAt15_5 = true
      if (timeLog.some((x) => Math.abs(x - 7.5) < 1e-3)) reappeared7_5 = true
      if (timeLog.some((x) => Math.abs(x - 4.0) < 1e-3)) cascadeToPrev = true
      if (timeLog.some((x) => Math.abs(x - 0.0) < 1e-3)) cascadeToPrev = true
      // Honour any loop-back the engine performed this frame.
      position = (video as unknown as { currentTime: number }).currentTime
    }
    // The loop re-locked to segment 5 and restarts at its padded start 15.5...
    expect(restartedAt15_5).toBe(true)
    // ...the old seg-3 restart (7.5) never reappears...
    expect(reappeared7_5).toBe(false)
    // ...and it never cascades into an earlier segment (seg 1/2).
    expect(cascadeToPrev).toBe(false)
    root.unmount()
    container.remove()
  })
})

describe('真实失败复现：回跳落点有 ±30ms 偏差时不级联', () => {
  it('loop-back landing +0.03s off (7.53 vs requested 7.5) keeps looping seg3, never cascades to seg2/seg1', () => {
    const { video, timeLog, root, container } = setup({
      segments: makeSegments(),
      loop: true,
      offset: 0,
      beatDuration: 0.5,
    })
    // Navigate to segment 3 (start = 8.0) and enable the loop (a real user seek).
    act(() => {
      video.currentTime = 8.0
      video.dispatchEvent(new Event('seeked'))
    })
    step()
    timeLog.length = 0

    // Simulate continuous playback with frame() + flushSeeked(). When the engine
    // crosses the padded loopEnd (12.5) it seeks back to loopStart 7.5 inside
    // the tick (queuing a `seeked`). We then OVERWRITE currentTime to 7.53 to
    // mimic a real browser's frame-level landing deviation (+30ms) BEFORE we
    // flush the seeked. The guard flag must still recognise this as the loop's
    // OWN seek regardless of the landing offset, so the target stays locked on
    // seg3 and restarts at 7.5 every cycle — no backward cascade.
    let position = 8.0
    let restartsAt7_5 = 0
    let soughtToSeg2Start = false
    let soughtToSeg1Start = false
    for (let i = 0; i < 400; i++) {
      timeLog.length = 0
      position += 0.05
      // Plain playback advance — must NOT enqueue a `seeked` (real browsers
      // don't fire `seeked` for normal playback).
      act(() => {
        video.currentTime = position
      })
      // Run the engine tick: may queue a loop-back `seeked` (in-tick seek).
      frame()
      // Simulate the real-browser +0.03s landing deviation on a loop-back.
      if (Math.abs(video.currentTime - 7.5) < 1e-3) {
        act(() => {
          video.currentTime = 7.53
        })
      }
      // Fire the queued `seeked` — reads currentTime = 7.53 while the guard
      // flag is still set, so onSeeked clears it without re-locking.
      flushSeeked()

      if (timeLog.some((x) => Math.abs(x - 7.5) < 1e-3)) restartsAt7_5++
      if (timeLog.some((x) => Math.abs(x - 4.0) < 1e-3)) soughtToSeg2Start = true
      if (timeLog.some((x) => Math.abs(x - 0.0) < 1e-3)) soughtToSeg1Start = true
      // Honour any loop-back the engine performed this frame.
      position = (video as unknown as { currentTime: number }).currentTime
    }

    // The loop keeps restarting at seg3's padded start (7.5) every cycle...
    expect(restartsAt7_5).toBeGreaterThanOrEqual(3)
    // ...and NEVER re-locks into segment 2 (start 4.0) or segment 1 (start 0.0)
    // — i.e. the backward cascade is gone. On the pre-fix code (10ms position
    // comparison) a +0.03s landing would be misread as a user jump into seg2,
    // re-locking the target and cascading, so restartsAt7_5 would stall at 1.
    expect(soughtToSeg2Start).toBe(false)
    expect(soughtToSeg1Start).toBe(false)
    root.unmount()
    container.remove()
  })
})
