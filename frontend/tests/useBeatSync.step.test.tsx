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

// ---------------------------------------------------------------------------
// QA 边界补充：单节循环开启状态下双击跳到另一小节的拍点。
// 断言三件事：
//   ① 视频暂停并定格在目标拍（stepBeat 的 pause 不被循环引擎立刻覆盖）；
//   ② 循环目标被重锁到新拍所在小节 —— stepBeat 有意不置 seekingForLoopRef，
//      其 seeked 走 onSeeked 的「真实用户 seek」分支，与拖拽行为一致。
//      观测方式：恢复播放后，循环回跳落点应为【新小节】的 padded loopStart，
//      且绝不回跳到旧小节的 padded start（无级联回退）；
//   ③ stepBeat 不重置循环开关本身 —— 恢复播放后循环仍在工作即为行为证明。
// ---------------------------------------------------------------------------

/** 模拟真实用户 seek 完成：任何 currentTime 赋值在真浏览器都会触发 seeked。 */
function fireSeeked(video: HTMLVideoElement) {
  act(() => {
    video.dispatchEvent(new Event('seeked'))
  })
}

/**
 * 从当前位置向前推进 `frames` 帧播放，收集循环引擎的回跳落点
 * （检测为单帧内 >=0.5s 的后退跳变）。与 qa.loopdrag 套件同款观测法。
 */
function collectLoopBacks(video: HTMLVideoElement, frames: number, stepSize = 0.05): number[] {
  let position = video.currentTime
  const backs: number[] = []
  let prev = position
  for (let i = 0; i < frames; i++) {
    position = Number((position + stepSize).toFixed(5))
    act(() => {
      video.currentTime = position
    })
    step()
    const cur = video.currentTime
    if (cur < prev - 0.5) backs.push(Number(cur.toFixed(3)))
    prev = cur
    position = cur // honour any loop-back the engine performed this frame
  }
  return backs
}

const near = (x: number, target: number, eps = 1e-3) => Math.abs(x - target) < eps

describe('QA 边界 — 单节循环开启时双击跨小节跳拍', () => {
  it('循环锁在第 1 节时 stepBeat(1) 跳到第 2 节首拍：定格 + 循环目标重锁到第 2 节，循环开关不被重置', () => {
    const { video, root, container } = setup({
      segments: makeSegments(),
      loop: true, // 单节循环已开启
      offset: 0,
      beatDuration: 0.5,
    })
    // 先跑一帧：loop 上升沿把 loopTargetRef 锁到播放头所在的第 1 节。
    act(() => {
      void video.play()
    })
    step()

    // 播放推进到第 1 节末拍之后（3.7s），仍在第 1 节内。
    act(() => {
      video.currentTime = 3.7
    })
    step()
    expect(last!.activeSegment).toBe(1)

    // 双击（前进）：跳到第 2 节首拍 4.0 并定格。
    act(() => {
      last!.stepBeat(1)
    })
    expect(video.currentTime).toBeCloseTo(4.0, 5)
    expect(video.paused).toBe(true) // ① 暂停定格在目标拍

    // 真实 <video> 会为这次 seek 触发 seeked；因 stepBeat 未置
    // seekingForLoopRef，onSeeked 走「真实用户 seek」分支 → 重锁循环目标。
    fireSeeked(video)

    // 定格期间引擎不得偷偷恢复播放或移动播放头（无越过 loopEnd 的跨越）。
    step()
    expect(video.paused).toBe(true)
    expect(video.currentTime).toBeCloseTo(4.0, 5)

    // 用户恢复播放：循环应围绕【第 2 节】工作。
    // 第 2 节 padded 窗口：loopStart = 4.0 - 0.5 = 3.5（一拍导入），
    // loopEnd = 8.0（末节无 trail-out）。第 1 节 padded start = 0。
    act(() => {
      void video.play()
    })
    const backs = collectLoopBacks(video, 240)

    // ② 重锁到新小节：至少一次回跳落在第 2 节 padded start 3.5。
    expect(
      backs.some((x) => near(x, 3.5)),
      `恢复播放后应在第 2 节 padded start (3.5) 回跳；实际回跳点 ${JSON.stringify(backs)}`,
    ).toBe(true)
    // 不级联：绝不回跳到第 1 节的 padded start (0)。
    expect(
      backs.some((x) => near(x, 0)),
      `不得回跳到旧小节起点 0（级联回退）；实际回跳点 ${JSON.stringify(backs)}`,
    ).toBe(false)
    // ③ 循环开关未被 stepBeat 重置 —— 有回跳发生即为循环仍然启用的行为证明。
    expect(backs.length).toBeGreaterThan(0)

    root.unmount()
    container.remove()
  })

  it('反向：循环锁在第 2 节时 stepBeat(-1) 跳回第 1 节拍点，循环目标随之重锁到第 1 节', () => {
    const { video, root, container } = setup({
      segments: makeSegments(),
      loop: true,
      offset: 0,
      beatDuration: 0.5,
    })
    act(() => {
      void video.play()
    })
    // 用户先拖拽到第 2 节（真实用户 seek → 目标锁到第 2 节）。
    act(() => {
      video.currentTime = 5.0
    })
    fireSeeked(video)
    step()
    expect(last!.activeSegment).toBe(2)

    // Shift+双击（后退）两次：5.0 → 4.5 → 4.0；再一次跨小节 → 3.5（第 1 节末拍）。
    act(() => {
      last!.stepBeat(-1)
    })
    expect(video.currentTime).toBeCloseTo(4.5, 5)
    fireSeeked(video)
    act(() => {
      last!.stepBeat(-1)
    })
    expect(video.currentTime).toBeCloseTo(4.0, 5)
    fireSeeked(video)
    act(() => {
      last!.stepBeat(-1)
    })
    expect(video.currentTime).toBeCloseTo(3.5, 5)
    expect(video.paused).toBe(true) // 每步都定格
    fireSeeked(video)

    // 恢复播放：循环应围绕【第 1 节】工作。
    // 第 1 节 padded 窗口：loopStart = 0（首节夹取），loopEnd = 4.0 + 0.5 = 4.5。
    act(() => {
      void video.play()
    })
    const backs = collectLoopBacks(video, 200)
    expect(
      backs.some((x) => near(x, 0)),
      `恢复播放后应在第 1 节 padded start (0) 回跳；实际回跳点 ${JSON.stringify(backs)}`,
    ).toBe(true)

    root.unmount()
    container.remove()
  })
})
