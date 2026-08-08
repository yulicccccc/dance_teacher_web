// QA 独立补测 — multi-loop × loopCount 组合路径（Part 2 交付概览里登记的非阻塞 backlog）
//
// 仅覆盖后端已交付、且既有 useBeatSync.multi / useBeatSync.loopcount 测试未显式
// 端到端联动的那条组合路径：多选段落循环(multi) 与 循环次数限制(loopCount) 一起开。
//
// 沿用既有 qa_independent_*.test.tsx 的 harness 写法：
//  - rAF 手动逐帧驱动；
//  - makeVideo 用普通变量背接 currentTime，timeLog 记录所有赋值；
//  - drive() 在每帧先设 currentTime、清空 timeLog、再 step()（引擎自身的 loop-back
//    seek 发生在 step() 内部），于是 step() 之后 timeLog 里只剩引擎发起的回跳目标，
//    天然同时覆盖 multi 的前向回跳与单节/AB 的后向回跳。
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

// Padded loopStarts of the selected segments [1, 3, 5].
const SELECTED_STARTS = [0, 7.5, 15.5]
function inSelected(t: number) {
  return SELECTED_STARTS.some((s) => Math.abs(s - t) < 1e-3)
}

describe('QA 独立补测 — multi-loop × loopCount 组合路径', () => {
  it('multi-loop + loopCount=4：只在勾选段间循环，整圈 wrap(末→首) 后受 loopCount 限制退出并继续播', () => {
    // 勾选 [1,3,5]，loopCount=4。预期：
    //   seg1 跨过扩展 loopEnd(4.5) -> 回到 seg3 起点 7.5   (iter 1)
    //   seg3 跨过扩展 loopEnd(12.5) -> 回到 seg5 起点 15.5  (iter 2)
    //   seg5 跨过 loopEnd(20) -> wrap 回 seg1 起点 0        (iter 3)
    //   seg1 再次跨过 loopEnd(4.5) -> iter 4 == loopCount 命中上限 -> 退出，不再回跳
    // 共 3 次回跳，且全部落在勾选段的起点集合 {0, 7.5, 15.5}。
    const { video, timeLog, root, container } = setup({
      segments: makeSegments(),
      loop: true,
      offset: 0,
      beatDuration: 0.5,
      loopMode: 'multi',
      loopSegmentIds: [1, 3, 5],
      loopCount: 4,
    })
    // 停在勾选段 seg1 中段(1.0) 启用，确保游标锚定到 seg1。
    act(() => {
      video.currentTime = 1.0
      video.dispatchEvent(new Event('seeked'))
    })
    step()

    const main = drive(video, timeLog, 1.0, 3000, 0.01)
    expect(main.loopBacks.length).toBe(3)
    expect(main.loopBacks.every((t) => inSelected(t))).toBe(true)
    expect(main.loopBacks.map((t) => Number(t.toFixed(3)))).toEqual([7.5, 15.5, 0])

    // 退出验证：继续驱动，确认不再产生任何回跳（不会卡死或无限循环）。
    const post = drive(video, timeLog, main.finalPosition, 600, 0.01)
    expect(post.loopBacks.length).toBe(0)

    root.unmount()
    container.remove()
  })

  it('multi-loop + loopCount=3：未走完整圈即受 loopCount 限制退出（不回跳到 seg1 起点 0）', () => {
    // loopCount=3：seg1->seg3 (iter1)、seg3->seg5 (iter2)、seg5 跨 loopEnd 时
    // iter3 == 上限 -> 退出，整圈未走完，绝不 wrap 回 seg1 起点 0。
    const { video, timeLog, root, container } = setup({
      segments: makeSegments(),
      loop: true,
      offset: 0,
      beatDuration: 0.5,
      loopMode: 'multi',
      loopSegmentIds: [1, 3, 5],
      loopCount: 3,
    })
    act(() => {
      video.currentTime = 1.0
      video.dispatchEvent(new Event('seeked'))
    })
    step()

    const main = drive(video, timeLog, 1.0, 3000, 0.01)
    expect(main.loopBacks.length).toBe(2)
    expect(main.loopBacks.every((t) => inSelected(t))).toBe(true)
    expect(main.loopBacks.map((t) => Number(t.toFixed(3)))).toEqual([7.5, 15.5])
    // 关键：达上限退出前绝不应 wrap 回 seg1 起点。
    expect(main.loopBacks.some((t) => Math.abs(t) < 1e-3)).toBe(false)

    const post = drive(video, timeLog, main.finalPosition, 600, 0.01)
    expect(post.loopBacks.length).toBe(0)

    root.unmount()
    container.remove()
  })

  it('multi-loop + 空选：降级为单节循环（只循环播放头所在段，不跳到勾选项起点）', () => {
    // loopMode='multi' 但 loopSegmentIds=[] -> 应降级为单节循环，循环播放头所在
    // 的 seg2（padded start 3.5），绝不跳到勾选项起点 {0, 7.5, 15.5}。
    // 此处在组合路径下确认既有 useBeatSync.multi 的断言仍然成立。
    const { video, timeLog, root, container } = setup({
      segments: makeSegments(),
      loop: true,
      offset: 0,
      beatDuration: 0.5,
      loopMode: 'multi',
      loopSegmentIds: [],
      // loopCount 留空 -> 降级后单节循环本应无限；只驱动有限帧核验降级行为。
    })
    // 播放头停在 seg2 中段(6.0)。
    act(() => {
      video.currentTime = 6.0
      video.dispatchEvent(new Event('seeked'))
    })
    step()

    const r = drive(video, timeLog, 6.0, 1500, 0.01)
    expect(r.loopBacks.length).toBeGreaterThan(0) // 确实在循环
    // 所有回跳都落在该段(seg2)的 padded start 3.5，绝不跳到勾选项起点。
    expect(r.loopBacks.every((t) => Math.abs(t - 3.5) < 1e-3)).toBe(true)
    expect(r.loopBacks.some((t) => inSelected(t))).toBe(false)

    root.unmount()
    container.remove()
  })

  it('multi-loop + active=false（对照模式）：不触发任何 loop seek', () => {
    // 对照模式 active=false 时，引擎只刷新 prevTime，不得发起任何 loop/AB seek。
    // 此处在 multi + 非空勾选的组合下确认既有 inactive 不 seek 断言仍然成立。
    const { video, timeLog, root, container } = setup({
      segments: makeSegments(),
      loop: true,
      offset: 0,
      beatDuration: 0.5,
      loopMode: 'multi',
      loopSegmentIds: [1, 3, 5],
      active: false,
    })
    act(() => {
      video.currentTime = 1.0
      video.dispatchEvent(new Event('seeked'))
    })
    step()

    const r = drive(video, timeLog, 1.0, 1500, 0.01)
    expect(r.loopBacks.length).toBe(0)
    // 播放头仍随驱动前进（未被回跳钳制），证明引擎仅刷新 prevTime。
    expect(r.finalPosition).toBeGreaterThan(1.0)

    root.unmount()
    container.remove()
  })
})
