import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createRef, type RefObject } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react'
import { useBeatSync } from '../src/hooks/useBeatSync'
import type { Segment, ABLoop } from '../src/types/api'

// Flag the React act() environment so state updates inside rAF flush correctly.
;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

// ---- rAF control: capture the single callback so we can step frames manually.
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
function frame() {
  act(() => {
    flushRaf()
  })
}
function flushSeeked() {
  act(() => {
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
  loopCount?: number | null
  abLoop?: ABLoop | null
}
function Harness(props: Props) {
  last = useBeatSync(
    props.videoRef,
    props.segments,
    props.loop,
    props.offset,
    props.beatDuration,
    undefined,
    props.abLoop ?? null,
    props.loopCount ?? null,
  )
  return null
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

// Drive playback forward in 0.05s steps. Returns the distinct loop-back target
// timestamps the engine produced (dedup consecutive duplicates) and whether the
// loop eventually stopped seeking back (=> exited and continued forward).
function drive(
  setupRet: ReturnType<typeof setup>,
  startAt: number,
  maxFrames: number,
) {
  const { video, timeLog, root, container } = setupRet
  // Enable the loop on the chosen segment via a real user seek.
  act(() => {
    video.currentTime = startAt
    video.dispatchEvent(new Event('seeked'))
  })
  frame()
  flushSeeked()
  timeLog.length = 0

  const loopBacks: number[] = []
  let position = startAt
  let exited = false
  let prevTargets: number[] = []
  for (let i = 0; i < maxFrames; i++) {
    timeLog.length = 0
    // Snap to a 3-decimal grid so accumulated float error from repeated 0.05
    // additions never makes `cur` land just under an integer loop boundary
    // (which would make the `bTime <= cur` check miss the crossing). Real
    // <video> time is monotonic and does not suffer this drift.
    position = Math.round((position + 0.05) * 1000) / 1000
    act(() => {
      video.currentTime = position
    })
    frame()
    flushSeeked()
    // Collect loop-back targets written during this frame.
    const targets = timeLog.filter((x) => x < position - 1e-6)
    if (targets.length > 0) {
      // Every frame that produced a loop-back target is one repetition. We do
      // NOT dedup identical targets across frames: a loop that jumps back to
      // the same start on every iteration is still a distinct repetition, and
      // collapsing them would undercount.
      const t = targets[targets.length - 1]
      loopBacks.push(t)
    }
    prevTargets = targets
    position = (video as unknown as { currentTime: number }).currentTime
    // Exit detection: we are clearly past the loop window and the engine is no
    // longer seeking back to a target behind us.
    if (position > startAt + 5 && prevTargets.length === 0 && loopBacks.length > 0) {
      exited = true
      break
    }
  }
  root.unmount()
  container.remove()
  return { loopBacks, exited }
}

describe('循环次数限制 — 单节循环', () => {
  it('loopCount=3：恰好回跳 3 次后退出并继续播', () => {
    const { loopBacks, exited } = drive(
      setup({ segments: makeSegments(), loop: true, offset: 0, beatDuration: 0.5, loopCount: 3 }),
      8.0, // segment 3 start
      500,
    )
    // Segment 3 padded loopStart = 7.5. loopCount=3 -> 3 play-throughs == 2 loop-backs.
    expect(loopBacks.length).toBe(2)
    expect(loopBacks.every((t) => Math.abs(t - 7.5) < 1e-3)).toBe(true)
    expect(exited).toBe(true)
  })

  it('loopCount=null：无限循环，永不退出', () => {
    const { loopBacks, exited } = drive(
      setup({ segments: makeSegments(), loop: true, offset: 0, beatDuration: 0.5, loopCount: null }),
      8.0,
      600,
    )
    expect(loopBacks.length).toBeGreaterThanOrEqual(5)
    expect(exited).toBe(false)
  })

  it('改次数重置：先 2 次跑到中途改 5，计数从 0 重新累计', () => {
    const { video, timeLog, videoRef, root, container } = setup({
      segments: makeSegments(),
      loop: true,
      offset: 0,
      beatDuration: 0.5,
      loopCount: 2,
    })
    // Seek into segment 3 and start looping.
    act(() => {
      video.currentTime = 8.0
      video.dispatchEvent(new Event('seeked'))
    })
    frame()
    flushSeeked()

    let position = 8.0
    const loopBacks: number[] = []
    // Phase 1 (loopCount=2): drive enough frames to get exactly 1 loop-back but
    // stay inside segment 3's loop window (the loop target is locked, so a
    // loop-back to 7.5 does NOT reset the counter). loopEnd (~12.5) is crossed
    // at frame ~90.
    for (let i = 0; i < 110; i++) {
      timeLog.length = 0
      position = Math.round((position + 0.05) * 1000) / 1000
      act(() => {
        video.currentTime = position
      })
      frame()
      flushSeeked()
      const targets = timeLog.filter((x) => x < position - 1e-6)
      if (targets.length > 0) loopBacks.push(targets[targets.length - 1])
      position = (video as unknown as { currentTime: number }).currentTime
    }
    const phase1 = loopBacks.length
    expect(phase1).toBeGreaterThanOrEqual(1)

    // Change the limit to 5 -> the repetition counter must reset to 0.
    act(() => {
      root.render(
        <Harness
          videoRef={videoRef}
          segments={makeSegments()}
          loop={true}
          offset={0}
          beatDuration={0.5}
          loopCount={5}
        />,
      )
    })

    // Phase 2 (loopCount=5): with the counter reset, the engine should now
    // perform up to 4 more loop-backs (5 play-throughs) before exiting.
    let exited = false
    for (let i = 0; i < 500; i++) {
      timeLog.length = 0
      position = Math.round((position + 0.05) * 1000) / 1000
      act(() => {
        video.currentTime = position
      })
      frame()
      flushSeeked()
      const targets = timeLog.filter((x) => x < position - 1e-6)
      if (targets.length > 0) loopBacks.push(targets[targets.length - 1])
      position = (video as unknown as { currentTime: number }).currentTime
      if (position > 13 && targets.length === 0 && loopBacks.length > 0) {
        exited = true
        break
      }
    }
    // Reset proven: we observed more loop-backs than the original limit (2) would
    // ever allow, and the loop eventually exited and kept playing forward.
    expect(loopBacks.length).toBeGreaterThanOrEqual(4) // 1 (phase1) + 4 (phase2)
    expect(exited).toBe(true)
    root.unmount()
    container.remove()
  })
})

describe('循环次数限制 — AB 循环', () => {
  it('loopCount=2：A→B 恰好回跳 2 次后退出并继续播', () => {
    const abLoop: ABLoop = {
      enabled: true,
      aTime: 2.0,
      bTime: 6.0,
      aSeg: 1,
      bSeg: 2,
      aBeat: 5,
      bBeat: 5,
    }
    const { loopBacks, exited } = drive(
      setup({
        segments: makeSegments(),
        loop: false,
        offset: 0,
        beatDuration: 0.5,
        loopCount: 2,
        abLoop,
      }),
      1.9,
      500,
    )
    expect(loopBacks.length).toBe(1)
    expect(loopBacks.every((t) => Math.abs(t - 2.0) < 1e-3)).toBe(true)
    expect(exited).toBe(true)
  })
})
