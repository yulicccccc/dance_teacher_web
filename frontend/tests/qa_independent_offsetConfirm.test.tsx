// QA 独立补测 — 偏移「草稿 + 确认」工作流（offset draft / confirm re-anchor）
//
// 覆盖两条路径（对应任务 A 交付的草稿+确认机制）：
//
//  ① 拖动期间循环稳定：仅改变传入 useBeatSync 的「beatOffset 差值参数」
//     （draftBeatOffset - beatOffset，对应 LessonPage 第 4 个参数），不改
//     segments 引用（offsetSegments 仍按已应用 beatOffset 切好）。此时引擎
//     effect 的 deps=[segments, videoRef] 未变 → 不重锚、不重切网格，单节循环
//     回跳落点始终锁定在初始节，不因「草稿」变化而错位。
//
//  ② 确认后重锚：确认偏移 = 传入一组「平移后的新 segments 数组」（模拟
//     resegmentSegments 在 beatOffset 变化后返回的新引用）。effect 因 segments
//     引用变化而重跑，重锚逻辑把 loopTargetRef 重新锚到「播放头当前所在节（新网格
//     下）」，否则循环会跳到被挪走的旧时间点。断言后续回跳落点落在新网格播放头
//     所在节的 padded start，而非旧编号对应的旧时间。
//
// 沿用既有 qa_independent_*.test.tsx 的 rAF 手动驱动 harness；cancelAnimationFrame
// 实现为真正从队列移除（而非 no-op），以便「确认后重渲染新 segments」能干净地
// 退役旧的 rAF tick，避免旧 segments 闭包残留产生幽灵回跳。
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createRef, type RefObject } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react'
import { useBeatSync, locateBeat } from '../src/hooks/useBeatSync'
import type { Segment } from '../src/types/api'

// Flag the React act() environment so state updates inside rAF flush correctly.
;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

// ---- rAF control: capture callbacks by id so we can cancel specific frames.
interface RafEntry {
  id: number
  cb: (t: number) => void
}
let rafQueue: RafEntry[] = []
let rafId = 0
const realRaf = globalThis.requestAnimationFrame
const realCaf = globalThis.cancelAnimationFrame
beforeEach(() => {
  rafQueue = []
  rafId = 0
  globalThis.requestAnimationFrame = ((cb: (t: number) => void) => {
    const id = ++rafId
    rafQueue.push({ id, cb })
    return id
  }) as unknown as typeof requestAnimationFrame
  // 真正从队列移除：确认后重渲染新 segments 时，旧 effect 的 cleanup 调用
  // cancelAnimationFrame 能把挂起的旧 tick 清掉，避免残留闭包幽灵回跳。
  globalThis.cancelAnimationFrame = ((id: number) => {
    rafQueue = rafQueue.filter((r) => r.id !== id)
  }) as typeof cancelAnimationFrame
})
afterEach(() => {
  globalThis.requestAnimationFrame = realRaf
  globalThis.cancelAnimationFrame = realCaf
})
function flushRaf() {
  const entries = rafQueue
  rafQueue = []
  for (const { cb } of entries) cb(0)
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

// 原网格整体前移 -2s（每段及每拍 -2s），index 仍 1..5。用于模拟「确认偏移后重切网格」：
//   seg1' = [-2, 2)    padded [0, 2.5)   -> loopStart 0 (首段 clamp 到 0)
//   seg2' = [2, 6)     padded [1.5, 6.5) -> loopStart max(2-0.5,0)=1.5
//   seg3' = [6, 10)    ...
// 播放头在 t=3.0 时，原网格落在 seg1([0,4))，新网格落在 seg2'([2,6)) —— 即重切后
// 「当前播放头所在节」变了，重锚应据此把循环目标切到 seg2'。
function makeShiftedSegments(): Segment[] {
  return Array.from({ length: 5 }, (_, i) => {
    const start = i * 4 - 2
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

describe('QA 独立补测 — 偏移草稿 + 确认重锚', () => {
  it('拖动期间(仅改 beatOffset 差值参数、不改 segments 引用)：单节循环回跳落点始终锁定初始节', () => {
    // 模拟 ControlBar 拖动滑块：每次只改 draftBeatOffset（传入 useBeatSync 的
    // 第 4 个参数 = draftBeatOffset - beatOffset），offsetSegments 引用不变。
    const segs = makeSegments()
    const { video, timeLog, root, container, videoRef } = setup({
      segments: segs,
      loop: true,
      offset: 0,
      beatDuration: 0.5,
      loopMode: 'single',
    })
    // 停在 seg1 中段(1.0) 启用循环，seeked 锁定到 seg1（padded start 0）。
    act(() => {
      video.currentTime = 1.0
      video.dispatchEvent(new Event('seeked'))
    })
    step()
    const r0 = drive(video, timeLog, 1.0, 1500, 0.01)
    expect(r0.loopBacks.length).toBeGreaterThan(0)
    expect(r0.loopBacks.every((t) => Math.abs(t) < 1e-3)).toBe(true) // 旧网格 seg1 起点 0

    // 模拟拖动到 +3 拍：仅改变传入 useBeatSync 的 offset 参数（=3），segments 引用
    // 不变。引擎每帧重读 beatOffsetRef，但 effect deps=[segments,videoRef] 未变 ->
    // 不重锚、不重切网格，循环目标 loopTargetRef 仍锁定 seg1。
    act(() => {
      root.render(
        <Harness
          videoRef={videoRef}
          segments={segs}
          loop
          offset={3}
          beatDuration={0.5}
          loopMode="single"
        />,
      )
    })

    const r1 = drive(video, timeLog, r0.finalPosition, 1500, 0.01)
    expect(r1.loopBacks.length).toBeGreaterThan(0)
    // 关键：回跳落点仍为旧网格 seg1 起点 0（未因 offset=3 的 1.5s 平移而错位到 1.5）。
    expect(r1.loopBacks.every((t) => Math.abs(t) < 1e-3)).toBe(true)
    // 绝不出现「按偏移平移」后的落点（如 1.5s），证明网格未被拖动实时重切。
    expect(r1.loopBacks.some((t) => Math.abs(t - 1.5) < 1e-3)).toBe(false)

    // 再拖回 0，循环仍稳定锁在 seg1（无残留、无错位）。
    act(() => {
      root.render(
        <Harness
          videoRef={videoRef}
          segments={segs}
          loop
          offset={0}
          beatDuration={0.5}
          loopMode="single"
        />,
      )
    })
    const r2 = drive(video, timeLog, r1.finalPosition, 1500, 0.01)
    expect(r2.loopBacks.every((t) => Math.abs(t) < 1e-3)).toBe(true)

    root.unmount()
    container.remove()
  })

  it('确认偏移(传入平移后的新 segments 数组)后：单节循环重锚到播放头当前所在节，落点落在新网格而非旧编号旧时间', () => {
    // 模拟「点击确认偏移」：resegmentSegments 在 beatOffset 变化后返回新引用 ->
    // 传入 useBeatSync 的是平移后的新 segments 数组。effect 因 segments 引用变化
    // 而重跑，重锚逻辑把 loopTargetRef 锚到「新网格下播放头当前所在节」。
    const segs = makeSegments()
    const shifted = makeShiftedSegments()
    const { video, timeLog, root, container, videoRef } = setup({
      segments: segs,
      loop: true,
      offset: 0,
      beatDuration: 0.5,
      loopMode: 'single',
    })
    // 锁定 seg1 并触发一次 loop-back（落点=旧网格 seg1 起点 0），建立「旧目标」。
    act(() => {
      video.currentTime = 1.0
      video.dispatchEvent(new Event('seeked'))
    })
    step()
    const r0 = drive(video, timeLog, 1.0, 600, 0.01)
    expect(r0.loopBacks.length).toBeGreaterThan(0)
    expect(Math.abs(r0.loopBacks[0]) < 1e-3).toBe(true) // 旧网格 seg1 起点 0

    // 把播放头放到 t=3.0（不 dispatch seeked，避免旧网格重新锚定）；用新网格重渲染，
    // 触发 effect 重跑 -> 重锚逻辑把 loopTargetRef 锚到「新网格下 t=3.0 所在节」。
    act(() => {
      video.currentTime = 3.0
    })
    act(() => {
      root.render(
        <Harness
          videoRef={videoRef}
          segments={shifted}
          loop
          offset={0}
          beatDuration={0.5}
          loopMode="single"
        />,
      )
    })

    // 新网格下 t=3.0 所在节应为 seg2'(index 2)，其 padded start = max(2-0.5,0)=1.5。
    const loc = locateBeat(shifted, 3.0, 3.0)
    expect(loc.activeSegment).toBe(2)
    const seg2 = shifted.find((s) => s.index === 2)!
    const expectedStart = Math.max(seg2.startTime - 0.5, 0) // 与 computePaddedLoopBounds 一致

    // 继续驱动：断言后续回跳落点全部落在新网格播放头当前节(seg2')的 padded start，
    // 而绝不在旧网格 seg1 起点 0（重锚失败、loopTargetRef 仍=1 时才会落 seg1' start 0），
    // 也绝不在旧网格 seg2(index 2) 的 padded start 3.5（证明不是「旧编号对应的旧时间」）。
    const r1 = drive(video, timeLog, 3.0, 1500, 0.01)
    expect(r1.loopBacks.length).toBeGreaterThan(0)
    expect(r1.loopBacks.every((t) => Math.abs(t - expectedStart) < 1e-3)).toBe(true)
    // 关键：NOT 旧网格 seg1 起点 0（若重锚失败、loopTargetRef 仍=1，则会落 seg1' start 0）
    expect(r1.loopBacks.some((t) => Math.abs(t) < 1e-3)).toBe(false)
    // NOT 旧网格 seg2(index 2) padded start 3.5（证明不是「旧编号对应的旧时间」）
    expect(r1.loopBacks.some((t) => Math.abs(t - 3.5) < 1e-3)).toBe(false)

    root.unmount()
    container.remove()
  })
})
