// QA 独立补测 — 单节循环竞态修复（"卡在当前小节" bug, T-fix）
//
// 复现并验证根因修复：单节循环(loopMode='single')开启时，用户点击左侧小节列表
// 某一项（如第 6 节），期望从此循环该小节；但旧逻辑因竞态仍循环之前锁定的小节。
//
// 竞态：goToSegment 调用 seek() 后，下一帧 rAF tick 可能在 `seeked` 事件之前运行；
// 此时 loopTargetRef 仍是旧小节，旧小节 padded loopEnd（含 ±1 拍缓冲）可能在新小节
// 起点之后，tick 误判播放头已越过旧 loopEnd，立即把播放头 seek 回旧小节起点 ——
// 即"卡在当前小节"。
//
// 修复：goToSegment 在单节循环模式下、seek 之前把目标小节 index 写入
// forceLoopTargetRef；useBeatSync 的 tick 在每帧最开头同步消费该 ref，把循环目标
// 强制切到点击的小节，消除竞态。
//
// 沿用既有 qa_independent_*.test.tsx 的 harness：
//  - rAF 手动逐帧驱动；
//  - makeVideo 用普通变量背接 currentTime，timeLog 记录所有赋值；
//  - drive() 在每帧先设 currentTime、清空 timeLog、再 step()（引擎自身的 loop-back
//    seek 发生在 step() 内部），于是 step() 之后 timeLog 里只剩引擎发起的回跳目标。
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createRef, type MutableRefObject, type RefObject } from 'react'
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
// seg1 = [0,4)    padded [0, 4.5)    -> loopStart 0
// seg2 = [4,8)    padded [3.5, 8.5)  -> loopStart 3.5
// seg3 = [8,12)   padded [7.5, 12.5) -> loopStart 7.5
// seg4 = [12,16)  padded [11.5, 16.5) -> loopStart 11.5
// seg5 = [16,20)  padded [15.5, 20)  -> loopStart 15.5 (last seg clamps loopEnd)
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

interface Props {
  videoRef: RefObject<HTMLVideoElement>
  segments: Segment[]
  loop: boolean
  offset: number
  beatDuration: number
  loopCount?: number | null
  loopMode?: 'single' | 'multi'
  loopSegmentIds?: number[]
  active?: boolean
  forceLoopTargetRef?: MutableRefObject<number | null>
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
    props.loopCount ?? null,
    props.loopMode ?? 'single',
    props.loopSegmentIds ?? [],
    props.active ?? true,
    props.forceLoopTargetRef,
  )
  return null
}

// jsdom clamps currentTime on an unloaded <video>, so we back it with a plain
// variable and record every assignment in `timeLog`.
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

// Drive the playhead forward in `stepSize` increments. Because the engine's own
// loop-back seek happens INSIDE `step()` (after we clear `timeLog`), the
// `timeLog` captured here holds ONLY engine-initiated seeks — i.e. the loop
// back-jump targets. We collect them into `loopBacks`.
function drive(
  video: HTMLVideoElement & { __timeLog: number[] },
  timeLog: number[],
  fromT: number,
  frames: number,
  stepSize: number,
): { loopBacks: number[]; finalPosition: number } {
  const loopBacks: number[] = []
  let position = fromT
  for (let i = 0; i < frames; i++) {
    position = Number((position + stepSize).toFixed(5))
    act(() => {
      video.currentTime = position
    })
    timeLog.length = 0
    step()
    for (const x of timeLog) loopBacks.push(x)
    position = (video as unknown as { currentTime: number }).currentTime
  }
  return { loopBacks, finalPosition: position }
}

// Padded loopStarts of the selected segments [1, 3, 5] (multi-mode fixture).
const SELECTED_STARTS = [0, 7.5, 15.5]
function inSelected(t: number) {
  return SELECTED_STARTS.some((s) => Math.abs(s - t) < 1e-3)
}

describe('QA 独立补测 — 单节循环竞态修复（forceLoopTargetRef）', () => {
  it('单节循环中点击不同小节，循环目标应跟随（回跳落点是新小节 padded start，而非旧小节）', () => {
    const forceLoopTargetRef: MutableRefObject<number | null> = { current: null }
    const { video, timeLog, root, container } = setup({
      segments: makeSegments(),
      loop: true,
      offset: 0,
      beatDuration: 0.5,
      loopMode: 'single',
      forceLoopTargetRef,
    })
    // 停在 seg1 中段(1.0) 启用循环，seeked 锁定到 seg1。
    act(() => {
      video.currentTime = 1.0
      video.dispatchEvent(new Event('seeked'))
    })
    step()

    // 先驱动若干帧：循环应锁定在 seg1，回跳落点都是 seg1 的 padded start 0。
    const r1 = drive(video, timeLog, 1.0, 1500, 0.01)
    expect(r1.loopBacks.length).toBeGreaterThan(0)
    expect(r1.loopBacks.every((t) => Math.abs(t) < 1e-3)).toBe(true) // 全部回到 seg1 起点 0

    // 模拟用户点击左侧小节列表第 3 节：goToSegment 在单节循环模式下 seek 之前写入
    // force target，并把播放头 seek 到第 3 节起点(8.0)。为复现竞态，这里「先 seek、
    // 不立即 dispatch seeked」——让下一帧 tick 在 seeked 事件到达前就运行。
    forceLoopTargetRef.current = 3
    act(() => {
      video.currentTime = 8.0 // seg3 起点，但不 dispatch 'seeked'（竞态窗口）
    })
    step() // tick 消费 force target -> loopTarget 强制切到 seg3

    // 随后 seeked 事件到达（真实浏览器异步触发），重新锚定（与新目标一致，无副作用）。
    act(() => {
      video.dispatchEvent(new Event('seeked'))
    })

    // 继续驱动：循环目标应是 seg3，回跳落点都是 seg3 的 padded start 7.5，绝不再回到 seg1 的 0。
    const r2 = drive(video, timeLog, 8.0, 1500, 0.01)
    expect(r2.loopBacks.length).toBeGreaterThan(0)
    expect(r2.loopBacks.every((t) => Math.abs(t - 7.5) < 1e-3)).toBe(true) // 全部回到 seg3 起点 7.5
    expect(r2.loopBacks.some((t) => Math.abs(t) < 1e-3)).toBe(false) // 绝不回跳到旧 seg1 起点 0
    // 关键：第一次强制切换后的回跳就应是新目标 7.5（而非旧 0）。
    expect(Math.abs(r2.loopBacks[0] - 7.5) < 1e-3).toBe(true)

    root.unmount()
    container.remove()
  })

  it('multi 模式下写 force target 应被忽略（不产生副作用，仍按勾选段循环）', () => {
    // 勾选 [1,3,5]。在 multi 模式下强行写入 force target = 2（seg2，padded start 3.5，
    // 不在勾选集合内）。按设计 force target 仅在 single 模式生效，multi 应忽略，循环
    // 仍只在勾选段 {0, 7.5, 15.5} 间发生，绝不回跳到 seg2 起点 3.5。
    const forceLoopTargetRef: MutableRefObject<number | null> = { current: null }
    const { video, timeLog, root, container } = setup({
      segments: makeSegments(),
      loop: true,
      offset: 0,
      beatDuration: 0.5,
      loopMode: 'multi',
      loopSegmentIds: [1, 3, 5],
      forceLoopTargetRef,
    })
    // 停在勾选段 seg1 中段(1.0)，确保游标锚定到 seg1。
    act(() => {
      video.currentTime = 1.0
      video.dispatchEvent(new Event('seeked'))
    })
    step()

    // 模拟竞态：multi 模式下写入 force target = 2 并 seek 到某处（不立即 dispatch seeked）。
    forceLoopTargetRef.current = 2
    act(() => {
      video.currentTime = 9.0 // 落在 seg3 区域内，但不 dispatch 'seeked'
    })
    step() // tick 应忽略该 force target（multi 模式）

    const r = drive(video, timeLog, 9.0, 2000, 0.01)
    expect(r.loopBacks.length).toBeGreaterThan(0)
    // 所有回跳仍落在勾选段起点集合 {0, 7.5, 15.5}。
    expect(r.loopBacks.every((t) => inSelected(t))).toBe(true)
    // 关键：绝不回跳到被强制指定的 seg2 起点 3.5（证明 force target 被忽略）。
    expect(r.loopBacks.some((t) => Math.abs(t - 3.5) < 1e-3)).toBe(false)

    root.unmount()
    container.remove()
  })

  it('非循环状态(loopSegment=false)下写 force target 无副作用（不发起任何 loop seek）', () => {
    // 未开启循环时写入 force target，引擎应立即丢弃循环目标，不产生任何回跳。
    const forceLoopTargetRef: MutableRefObject<number | null> = { current: null }
    const { video, timeLog, root, container } = setup({
      segments: makeSegments(),
      loop: false,
      offset: 0,
      beatDuration: 0.5,
      loopMode: 'single',
      forceLoopTargetRef,
    })
    act(() => {
      video.currentTime = 1.0
      video.dispatchEvent(new Event('seeked'))
    })
    step()

    // 写 force target 并 seek，但不开启循环。
    forceLoopTargetRef.current = 3
    act(() => {
      video.currentTime = 10.0
    })
    step()

    // 未开启循环：即使越过任何 loopEnd 也不应回跳。
    const r = drive(video, timeLog, 10.0, 1500, 0.01)
    expect(r.loopBacks.length).toBe(0)
    // 播放头随驱动前进（未被循环钳制）。
    expect(r.finalPosition).toBeGreaterThan(10.0)

    root.unmount()
    container.remove()
  })
})
