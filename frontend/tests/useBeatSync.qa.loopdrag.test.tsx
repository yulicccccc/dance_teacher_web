/**
 * QA boundary test — single-segment loop UNDER FREQUENT USER DRAGS.
 *
 * Independent complement to `useBeatSync.test.tsx` and
 * `useBeatSync.qa.regression.test.tsx`. Those files exercise the cascade
 * invariant and the ±30ms landing-deviation regression, but they each do a
 * single user seek mid-loop. This file stresses the loop with MANY successive
 * drags to DIFFERENT segments while the loop is live, asserting two things that
 * together prove the fix (guard-flag `seekingForLoopRef`) holds under churn:
 *
 *   1. FOLLOW: after each drag to segment N, the loop restarts at N's padded
 *      start — the target re-locks to wherever the user dragged.
 *   2. NO CASCADE: while a segment N is the locked target, the engine NEVER
 *      restarts at a segment whose index is STRICTLY SMALLER than N on its own
 *      (no spontaneous backward drift through the timeline). A genuine user
 *      drag to an earlier segment is a legitimate re-lock, but the loop must
 *      then stay put and never cascade one step further back.
 *
 * The harness models a real <video>: a programmatic seek performed INSIDE a rAF
 * tick (the engine's own loop-back) fires `seeked` once the frame completes,
 * which is exactly what the guard-flag design needs to clear
 * `seekingForLoopRef`. Plain playback advances driven by the test run OUTSIDE
 * a tick and stay silent.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createRef, type RefObject } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react'
import { useBeatSync } from '../src/hooks/useBeatSync'
import type { Segment } from '../src/types/api'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

// ---- rAF control + seeked modeling (mirrors a real <video>).
type RafCb = (t: number) => void
let rafQueue: RafCb[] = []
let pendingSeeked: Array<() => void> = []
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
// One frame, then flush the engine's queued loop-back `seeked` events.
function step() {
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

// Padded loop start for segment with the given 1-based index (one beat of
// lead-in, clamped at t=0 for seg 1).
function paddedStart(index: number): number {
  return index === 1 ? 0 : (index - 1) * 4 - 0.5
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

function makeVideo() {
  let current = 0
  const video = document.createElement('video') as HTMLVideoElement
  Object.defineProperty(video, 'currentTime', {
    configurable: true,
    get: () => current,
    set: (v: number) => {
      current = v
      if (inFrame) {
        pendingSeeked.push(() => video.dispatchEvent(new Event('seeked')))
      }
    },
  })
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

/** Genuine USER drag: set time then fire `seeked` (re-locks the loop target). */
function userDrag(video: HTMLVideoElement, t: number) {
  act(() => {
    video.currentTime = t
    video.dispatchEvent(new Event('seeked'))
  })
}

const near = (x: number, target: number, eps = 1e-3) => Math.abs(x - target) < eps

/**
 * Play `frames` frames of forward playback from the video's current position.
 * Returns the list of loop-back RESTART targets (padded loopStart the engine
 * sought back to), detected as large backward jumps in currentTime (>=0.5s).
 */
function collectLoopBacks(video: HTMLVideoElement, frames: number, stepSize = 0.05): number[] {
  let position = (video as unknown as { currentTime: number }).currentTime
  const backs: number[] = []
  let prev = position
  for (let i = 0; i < frames; i++) {
    position = Number((position + stepSize).toFixed(5))
    act(() => {
      video.currentTime = position
    })
    step()
    const cur = (video as unknown as { currentTime: number }).currentTime
    if (cur < prev - 0.5) backs.push(Number(cur.toFixed(3)))
    prev = cur
    position = cur // honour any loop-back the engine performed this frame
  }
  return backs
}

describe('QA 边界 — 循环中频繁拖拽: 目标跟随每次拖拽且不级联回更早小节', () => {
  it('drgs through seg3→seg4→seg2→seg5→seg1→seg3: each re-locks, no backward cascade', () => {
    const { video, root, container } = setup({
      segments: makeSegments(),
      loop: true,
      offset: 0,
      beatDuration: 0.5,
    })

    // 1-based segment index the drag targets, in churn order. Includes an
    // EARLIER segment (seg2, seg1) reached by dragging backward — that is a
    // legitimate user re-lock, but the loop must then stay put and never
    // cascade one further step back.
    const dragTargets = [3, 4, 2, 5, 1, 3]

    for (const idx of dragTargets) {
      // The segment's actual start time (index*4). Drag there.
      userDrag(video, (idx - 1) * 4)
      // Run several cycles so we can confirm stable looping at this target.
      const backs = collectLoopBacks(video, 300)
      const targetStart = paddedStart(idx)

      // FOLLOW: at least one restart at THIS segment's padded start.
      expect(
        backs.some((x) => near(x, targetStart)),
        `after dragging to seg ${idx}, loop should restart at its padded start ${targetStart}; got restarts ${JSON.stringify(backs)}`,
      ).toBe(true)

      // NO CASCADE: while seg ${idx} is locked, never restart at any segment
      // whose index is strictly smaller (spontaneous backward drift).
      for (let earlier = 1; earlier < idx; earlier++) {
        const prevStart = paddedStart(earlier)
        expect(
          backs.some((x) => near(x, prevStart)),
          `looping target seg ${idx} must NOT cascade to earlier seg ${earlier} (start ${prevStart}); restarts ${JSON.stringify(backs)}`,
        ).toBe(false)
      }
    }

    root.unmount()
    container.remove()
  })

  it('rapid successive drags within a single cycle each re-lock (no stuck target)', () => {
    const { video, root, container } = setup({
      segments: makeSegments(),
      loop: true,
      offset: 0,
      beatDuration: 0.5,
    })
    // A real user scrubbing fast may land on a new segment before the previous
    // loop cycle even completes. Drag seg3→seg5→seg2→seg4 with only a SHORT
    // playback burst (1.5 cycles) between drags. Every subsequent lock must be
    // honored; the loop must never get "stuck" on the first segment.
    const drags = [3, 5, 2, 4]
    for (const idx of drags) {
      userDrag(video, (idx - 1) * 4)
      const backs = collectLoopBacks(video, 120)
      const targetStart = paddedStart(idx)
      expect(
        backs.some((x) => near(x, targetStart)),
        `rapid drag to seg ${idx} should re-lock and restart at ${targetStart}; restarts ${JSON.stringify(backs)}`,
      ).toBe(true)
    }
    root.unmount()
    container.remove()
  })
})
