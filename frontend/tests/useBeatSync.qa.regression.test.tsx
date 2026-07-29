/**
 * Independent QA regression suite for the single-segment-loop "follows the
 * playhead" bug (team: software-bugfix-loop).
 *
 * Bug under test (PRD / team brief):
 *   `loopTargetRef` is locked the instant the single-segment loop is enabled
 *   and is NOT re-locked when the user jumps / scrubs / the playhead moves, so
 *   the loop gets stuck on the originally-locked section ("卡死在最初锁定的小节")
 *   or silently stops looping ("静默失效").
 *
 * This file is written independently of the engineer's own tests. Every test
 * below asserts the POST-FIX behaviour and would FAIL against the pre-fix
 * implementation (where `onSeeked` never re-locked `loopTargetRef`). It is the
 * QA counterpart confirming the fix (`b6e0a4a`) actually works.
 *
 * Harness notes (so the tests are not themselves flaky):
 *  - Playback positions are kept EXACT via `Number((base + k*step).toFixed(5))`.
 *    The engine's loop-end detection uses an inclusive `loopEnd <= cur` check
 *    with a 1e-3 epsilon; naive `position += 0.05` float drift can land the
 *    frame a hair under an exact boundary (e.g. 4.499999999999999) and cause
 *    the loop to be MISSED — that is a harness artefact, not a source bug.
 *  - A loop-back is detected as a LARGE BACKWARD jump in `currentTime`. Natural
 *    forward playback only ever increases time, so a backward jump can ONLY be
 *    the engine seeking back to its padded loop start. This avoids mistaking a
 *    normal pass-through of a segment start (e.g. 7.5) for a loop restart.
 *  - Programmatic seeks performed INSIDE a rAF tick (the engine's own loop-back)
 *    are made to fire a `seeked` event once the frame completes — matching the
 *    real <video> behaviour the post-fix guard-flag design (`seekingForLoopRef`)
 *    relies on. Without this the guard flag would never be cleared and genuine
 *    user drags would fail to re-lock the loop target. Plain playback advances
 *    driven by the tests run OUTSIDE a tick and stay silent (no `seeked`).
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createRef, type RefObject } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react'
import { useBeatSync, locateBeat, computeLoopSegment, computePaddedLoopBounds } from '../src/hooks/useBeatSync'
import type { Segment, ABLoop } from '../src/types/api'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

type RafCb = (t: number) => void
let rafQueue: RafCb[] = []
// `seeked` events queued by the video's `currentTime` setter while a rAF tick
// is running (i.e. the engine's own programmatic loop-back seek). Flushed by
// `stepFrame()` after the frame, mimicking a real <video> firing `seeked` once
// the seek completes. THIS IS REQUIRED by the post-fix guard-flag design:
// `useBeatSync` sets `seekingForLoopRef=true` immediately before a programmatic
// loop-back (`v.currentTime = bounds.loopStart`) and clears it inside the
// `seeked` listener. If `seeked` never fires for the programmatic seek the
// flag stays stuck `true` and genuine user drags are (wrongly) treated as the
// loop's own loop-back, so the target never re-locks. A real browser DOES fire
// `seeked` for programmatic seeks — this harness models that.
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
// Run one animation frame inside act(), then flush any `seeked` events queued
// by the engine's programmatic loop-back seeks during that frame. This is where
// the guard flag in useBeatSync gets cleared, exactly like a real browser.
function stepFrame() {
  act(() => {
    flushRaf()
    const evs = pendingSeeked
    pendingSeeked = []
    for (const e of evs) e()
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
  abLoop?: ABLoop | null
}
function Harness(props: Props) {
  last = useBeatSync(props.videoRef, props.segments, props.loop, props.offset, props.beatDuration, undefined, props.abLoop ?? null)
  return null
}

function makeVideo() {
  let current = 0
  const video = document.createElement('video') as HTMLVideoElement & { __timeLog: number[] }
  Object.defineProperty(video, 'currentTime', {
    configurable: true,
    get: () => current,
    set: (v: number) => {
      current = v
      // Model a real <video>: a programmatic seek performed INSIDE a rAF tick
      // (the engine's own single-segment / A→B loop-back) fires a `seeked`
      // event once the seek lands. The guard-flag design (`seekingForLoopRef`)
      // depends on this to tell the loop's OWN seek from a genuine user drag.
      // A plain playback advance set by the test runs OUTSIDE a tick and must
      // stay silent, otherwise every per-frame advance would be read as a user
      // drag and re-lock the loop target every frame (breaking the cascade
      // guards).
      if (inFrame) {
        pendingSeeked.push(() => video.dispatchEvent(new Event('seeked')))
      }
    },
  })
  video.__timeLog = []
  video.play = vi.fn(() => Promise.resolve()) as unknown as HTMLMediaElement['play']
  video.pause = vi.fn() as unknown as HTMLMediaElement['pause']
  return { video }
}

function setup(props: Omit<Props, 'videoRef'>) {
  const videoRef = createRef<HTMLVideoElement>()
  const { video } = makeVideo()
  videoRef.current = video
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root: Root = createRoot(container)
  act(() => {
    root.render(<Harness {...props} videoRef={videoRef} />)
  })
  return { videoRef, video, root, container }
}

/** Simulate a genuine USER seek: change time then fire the `seeked` event. */
function userSeek(video: HTMLVideoElement, t: number) {
  act(() => {
    video.currentTime = t
    video.dispatchEvent(new Event('seeked'))
  })
}

const near = (x: number, target: number, eps = 1e-3) => Math.abs(x - target) < eps

/**
 * Drive `frames` frames of forward playback from the video's current time and
 * return the list of loop-back RESTART targets (the padded `loopStart` the
 * engine sought back to), detected as backwards jumps in currentTime.
 */
function collectLoopBacks(video: HTMLVideoElement, frames: number, step = 0.05): number[] {
  let position = (video as unknown as { currentTime: number }).currentTime
  const backs: number[] = []
  let prev = position
  for (let i = 0; i < frames; i++) {
    position = Number((position + step).toFixed(5))
    act(() => {
      video.currentTime = position
    })
    stepFrame()
    const cur = (video as unknown as { currentTime: number }).currentTime
    // A genuine loop restart is the only thing that makes currentTime drop by
    // a large amount in a single frame (the padded window is ~5s wide).
    if (cur < prev - 0.5) backs.push(Number(cur.toFixed(3)))
    prev = cur
    position = cur // honour any loop-back the engine performed this frame
  }
  return backs
}

// =============================================================================
// 1) CORE BUG: loop target MUST re-lock when the user seeks to a new section.
// =============================================================================
describe('QA 独立回归 — 核心 Bug: 用户跳转后循环目标重锁定 (re-lock on user seek)', () => {
  it('looping seg 3, user drags to seg 5 → re-locks to seg 5 (restart at 15.5), never stuck on 7.5, no cascade', () => {
    const { video, root, container } = setup({
      segments: makeSegments(),
      loop: true,
      offset: 0,
      beatDuration: 0.5,
    })
    // Navigate to segment 3 (start = 8.0).
    userSeek(video, 8.0)
    stepFrame()
    // Pre-condition: the loop is actually looping segment 3 (restart at 7.5).
    const pre = collectLoopBacks(video, 200)
    expect(pre.some((x) => near(x, 7.5))).toBe(true)

    // THE BUG SCENARIO: user drags the playhead to segment 5.
    userSeek(video, 16.0)

    const backs = collectLoopBacks(video, 800)
    // Fix confirmed: loop followed the playhead to segment 5...
    expect(backs.some((x) => near(x, 15.5))).toBe(true)
    // ...the OLD segment-3 window never reappears (loop is not stuck)...
    expect(backs.some((x) => near(x, 7.5))).toBe(false)
    // ...and it never cascaded into an earlier section (seg 1/2 restarts).
    expect(backs.some((x) => near(x, 4.0))).toBe(false)
    expect(backs.some((x) => near(x, 0.0))).toBe(false)
    root.unmount()
    container.remove()
  })

  it('user seeks BACKWARD to seg 1 while looping seg 3 → re-locks seg 1 (restart at 0)', () => {
    const { video, root, container } = setup({
      segments: makeSegments(),
      loop: true,
      offset: 0,
      beatDuration: 0.5,
    })
    userSeek(video, 8.0) // seg 3
    stepFrame()
    // establish seg-3 looping
    collectLoopBacks(video, 200)
    // User drags backward to segment 1 (start = 0.0).
    userSeek(video, 0.0)

    const backs = collectLoopBacks(video, 800)
    expect(backs.some((x) => near(x, 0.0))).toBe(true) // re-locked to seg 1
    expect(backs.some((x) => near(x, 7.5))).toBe(false) // no longer stuck on seg 3
    root.unmount()
    container.remove()
  })

  it('multiple successive user seeks each re-lock correctly (seg3→seg5→seg2→seg4)', () => {
    const { video, root, container } = setup({
      segments: makeSegments(),
      loop: true,
      offset: 0,
      beatDuration: 0.5,
    })
    const targets = [
      { seek: 8.0, start: 7.5 }, // seg 3
      { seek: 16.0, start: 15.5 }, // seg 5
      { seek: 4.0, start: 3.5 }, // seg 2 (padded start sits in prev phrase)
      { seek: 12.0, start: 11.5 }, // seg 4
    ]
    for (const { seek, start } of targets) {
      userSeek(video, seek)
      const backs = collectLoopBacks(video, 250)
      expect(backs.some((x) => near(x, start))).toBe(true)
      // and it must NOT still be restarting at the previously-locked start
      for (const other of targets) {
        if (other.start !== start) {
          expect(backs.some((x) => near(x, other.start))).toBe(false)
        }
      }
    }
    root.unmount()
    container.remove()
  })
})

// =============================================================================
// 2) RISING-EDGE: enabling loop mid-section locks to the CURRENT section, not
//    the next one it would cross (prevents locking to the wrong bar).
// =============================================================================
describe('QA 独立回归 — 上升沿: 开启循环即锁定当前小节 (lock current section on enable)', () => {
  it('enabling loop while playing seg 3 immediately locks seg 3 (restart at 7.5), not seg 4', () => {
    const { videoRef, video, root, container } = setup({
      segments: makeSegments(),
      loop: false, // loop OFF initially
      offset: 0,
      beatDuration: 0.5,
    })
    // Play (without looping) and navigate into segment 3.
    userSeek(video, 8.0)
    stepFrame()
    // Now ENABLE the loop (re-render with loop=true).
    act(() => {
      root.render(
        <Harness videoRef={videoRef} segments={makeSegments()} loop={true} offset={0} beatDuration={0.5} />,
      )
    })
    stepFrame() // rising edge must lock to seg 3 immediately

    const backs = collectLoopBacks(video, 400)
    expect(backs.some((x) => near(x, 7.5))).toBe(true) // locked current section
    expect(backs.some((x) => near(x, 11.5))).toBe(false) // never the next bar (seg 4)
    root.unmount()
    container.remove()
  })
})

// =============================================================================
// 3) CLAMP: first/last segments must not loop before t=0 or past media end.
// =============================================================================
describe('QA 独立回归 — 边界: 首/尾小节循环窗口被夹在媒体范围内', () => {
  it('enable loop at segment 1 (t=0) → loopStart clamps to 0 (no negative start)', () => {
    const { video, root, container } = setup({
      segments: makeSegments(),
      loop: true,
      offset: 0,
      beatDuration: 0.5,
    })
    userSeek(video, 0.0)
    stepFrame()
    const backs = collectLoopBacks(video, 400)
    expect(backs.some((x) => near(x, 0.0))).toBe(true)
    expect(backs.some((x) => x < -1e-6)).toBe(false) // no negative loop start
    root.unmount()
    container.remove()
  })

  it('enable loop at last segment (t=16) → loopEnd clamps to 20 (no buffer past media end)', () => {
    const { video, root, container } = setup({
      segments: makeSegments(),
      loop: true,
      offset: 0,
      beatDuration: 0.5,
    })
    userSeek(video, 16.0) // seg 5, last segment
    stepFrame()
    const backs = collectLoopBacks(video, 400)
    expect(backs.some((x) => near(x, 15.5))).toBe(true)
    expect(backs.some((x) => x > 20.0 + 1e-6)).toBe(false) // no buffer past media end
    root.unmount()
    container.remove()
  })
})

// =============================================================================
// 4) DISABLE/RE-ENABLE: target is cleared on disable and re-acquired on enable.
// =============================================================================
describe('QA 独立回归 — 关闭再开启: 目标清空后重新获取', () => {
  it('disable loop clears the locked target; re-enable re-acquires at current section', () => {
    const { videoRef, video, root, container } = setup({
      segments: makeSegments(),
      loop: true,
      offset: 0,
      beatDuration: 0.5,
    })
    userSeek(video, 8.0) // seg 3
    stepFrame()
    collectLoopBacks(video, 200) // confirm looping seg 3
    // Disable loop.
    act(() => {
      root.render(
        <Harness videoRef={videoRef} segments={makeSegments()} loop={false} offset={0} beatDuration={0.5} />,
      )
    })
    stepFrame()
    // While disabled there should be NO loop-backs (target was cleared).
    expect(collectLoopBacks(video, 200).length).toBe(0)
    // Return to segment 3, then re-enable loop (rising edge must re-acquire).
    userSeek(video, 8.0)
    act(() => {
      root.render(
        <Harness videoRef={videoRef} segments={makeSegments()} loop={true} offset={0} beatDuration={0.5} />,
      )
    })
    stepFrame()
    const backs = collectLoopBacks(video, 400)
    expect(backs.some((x) => near(x, 7.5))).toBe(true) // re-acquired seg 3 on re-enable
    root.unmount()
    container.remove()
  })
})

// =============================================================================
// 5) A→B loop priority: when AB is active, the single-segment loop must defer.
// =============================================================================
describe('QA 独立回归 — A→B 循环优先于单节循环', () => {
  it('AB loop active jumps back to aTime, not the padded single-segment loopStart', () => {
    const abLoop: ABLoop = { aTime: 8.0, bTime: 10.0, enabled: true, createdAt: 0 }
    const { video, root, container } = setup({
      segments: makeSegments(),
      loop: true, // single-segment loop also on
      offset: 0,
      beatDuration: 0.5,
      abLoop,
    })
    userSeek(video, 8.0)
    stepFrame()
    const backs = collectLoopBacks(video, 400)
    expect(backs.some((x) => near(x, 8.0))).toBe(true) // AB returns to aTime
    expect(backs.some((x) => near(x, 7.5))).toBe(false) // single-segment loopStart never used
    root.unmount()
    container.remove()
  })
})

// =============================================================================
// 6) Pure-function unit tests (no <video> needed) — supporting math.
// =============================================================================
describe('QA 独立回归 — 纯函数: 循环边界与目标计算', () => {
  const segs = makeSegments()

  it('computeLoopSegment returns the segment whose END was crossed this frame', () => {
    expect(computeLoopSegment(segs, 3.5, 4.5)?.index).toBe(1)
    expect(computeLoopSegment(segs, 11.5, 12.5)?.index).toBe(3)
    expect(computeLoopSegment(segs, 5.0, 5.4)).toBeNull() // no boundary crossed
    expect(computeLoopSegment([], 1, 2)).toBeNull() // empty segments
  })

  it('computePaddedLoopBounds clamps at timeline edges and pads interior by one beat', () => {
    expect(computePaddedLoopBounds(segs[2], segs, 0.5)).toEqual({ loopStart: 7.5, loopEnd: 12.5 })
    expect(computePaddedLoopBounds(segs[0], segs, 0.5)).toEqual({ loopStart: 0, loopEnd: 4.5 })
    expect(computePaddedLoopBounds(segs[4], segs, 0.5)).toEqual({ loopStart: 15.5, loopEnd: 20 })
    expect(computePaddedLoopBounds(segs[2], segs, 0)).toEqual({ loopStart: 8, loopEnd: 12 }) // unsafe beatDuration
  })

  it('locateBeat finds the active segment, beat number, and crossed flag', () => {
    expect(locateBeat(segs, 2.0, 1.9)).toMatchObject({ activeSegment: 1, beatIndex: 5, crossed: true })
    expect(locateBeat(segs, 999, 998).activeSegment).toBe(5) // clamps to last
    expect(locateBeat([], 1, 0)).toMatchObject({ activeSegment: 0, beatIndex: 0, crossed: false })
  })
})
