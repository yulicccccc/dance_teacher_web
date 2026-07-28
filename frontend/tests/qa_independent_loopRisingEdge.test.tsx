import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createRef, type RefObject } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react'
import { useBeatSync, computeLoopSegment } from '../src/hooks/useBeatSync'
import type { Segment, ABLoop } from '../src/types/api'
import BeatOverlay from '../src/components/BeatOverlay'

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
// Segment 1 = [0, 4), padded loop window [0, 4.5) -> loopStart 0 (first seg clamps).
// Segment 2 = [4, 8), padded loop window [3.5, 8.5) -> loopStart 3.5.
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
  abLoop?: ABLoop | null
}
function Harness(props: Props) {
  useBeatSync(
    props.videoRef,
    props.segments,
    props.loop,
    props.offset,
    props.beatDuration,
    undefined,
    props.abLoop ?? null,
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

describe('QA 独立回归 — 单节循环上升沿（工程师用例未覆盖的风险点）', () => {
  it('在 t=0（首节起点）启用循环 → 上升沿锁定首节，回到 loopStart=0 而非下一节的 3.5', () => {
    // 工程师只测了中段(6.0)与边界盲区(7.9995)。补充首节起点这一对称边界：
    // 在 t=0 启用单节循环，上升沿应锁定 segment 1（loopStart 被钳到 0），
    // 越过扩展 loopEnd(4.5) 回到 0，而不是错误地跳到 segment 2 的 loopStart(3.5)。
    const { video, timeLog, root, container } = setup({
      segments: makeSegments(),
      loop: true,
      offset: 0,
      beatDuration: 0.5,
    })
    act(() => {
      video.currentTime = 0
      video.dispatchEvent(new Event('seeked'))
    })
    step()

    let sawFirst = false
    let sawNext = false
    drive(video, timeLog, 0, 3000, 0.01, (x) => {
      if (Math.abs(x) < 1e-6) sawFirst = true // segment 1 的 loopStart = 0
      if (Math.abs(x - 3.5) < 1e-3) sawNext = true // segment 2 的 loopStart = 3.5
    })
    expect(sawFirst).toBe(true)
    expect(sawNext).toBe(false)
    root.unmount()
    container.remove()
  })

  it('A→B 循环启用时，单节循环分支被完整跳过 —— 不会触发单节 padded seek（互斥护栏）', () => {
    // 旧逻辑若把 loopTargetRef 误用在 AB 启用期间，会在跨过 segment 2 扩展
    // loopEnd(8.5) 时 seek 到 3.5。断言：AB 启用期间只出现回到 aTime(5.0) 的
    // 回跳，绝不出现单节 loopStart(3.5)。这验证 rising-edge 设置 loopTargetRef
    // 不会“泄漏”到 AB 激活时的单节分支。
    const abLoop: ABLoop = { enabled: true, aTime: 5.0, bTime: 6.0 }
    const { video, timeLog, root, container } = setup({
      segments: makeSegments(),
      loop: true,
      offset: 0,
      beatDuration: 0.5,
      abLoop,
    })
    // 停在 segment 2 中段(5.0) 启用（loop + AB 同时开）。
    act(() => {
      video.currentTime = 5.0
      video.dispatchEvent(new Event('seeked'))
    })
    step()

    let sawAB = false
    let sawSingle = false
    drive(video, timeLog, 5.0, 1500, 0.01, (x) => {
      if (Math.abs(x - 5.0) < 1e-3) sawAB = true // AB 回到 aTime = 5.0
      if (Math.abs(x - 3.5) < 1e-3) sawSingle = true // 单节 segment 2 loopStart = 3.5
    })
    expect(sawAB).toBe(true)
    expect(sawSingle).toBe(false)
    root.unmount()
    container.remove()
  })

  it('seg 为 null 时启用（空 segments）→ 上升沿被跳过、不会误锁，且不崩溃', () => {
    // 验证 rising-edge 护栏：在 segments 为空（seg 恒为 null）时启用循环，
    // `if (loopRef.current && !wasLoopRef.current && seg)` 因 seg 为 null 不锁定
    // loopTargetRef（保持 null），单节循环分支回落到 computeLoopSegment 兜底也
    // 找不到段 → 不会发起任何回跳、也不会抛错。这与“旧逻辑在 seg 为 null 时
    // 同样不锁定”的行为一致（兜底分支仍在，见下方 computeLoopSegment 单测）。
    const { video, timeLog, root, container } = setup({
      segments: [],
      loop: true,
      offset: 0,
      beatDuration: 0.5,
    })
    act(() => {
      video.currentTime = 0
      video.dispatchEvent(new Event('seeked'))
    })
    timeLog.length = 0 // 丢弃我自己的写入，只看引擎自身的 seek
    step()
    expect(timeLog.length).toBe(0) // rising edge 因 seg=null 跳过 → 无回跳

    // 持续推进播放头，确认空 segments 期间永远不会有单节循环回跳。
    drive(video, timeLog, 0, 600, 0.1, () => {})
    expect(timeLog.length).toBe(0)
    root.unmount()
    container.remove()
  })

  it('兜底函数 computeLoopSegment 行为不变：跨过某节末端即返回该节，否则返回 null', () => {
    // 直接对导出的纯函数做单测，证明“兜底分支 computeLoopSegment”逻辑仍在且
    // 旧行为不变：只有真正跨过某节 endTime 的那一帧才会锁定该节，其余情况返回 null。
    const segs = makeSegments()
    // 跨过首节末端 4.0：prev=3.99, cur=4.0 -> 返回 segment 1 (index 1)
    expect(computeLoopSegment(segs, 3.99, 4.0)?.index).toBe(1)
    // 跨过第二节末端 8.0：prev=7.99, cur=8.0 -> 返回 segment 2 (index 2)
    expect(computeLoopSegment(segs, 7.99, 8.0)?.index).toBe(2)
    // 仅在本节内部移动，未跨过任何末端 -> null
    expect(computeLoopSegment(segs, 3.0, 3.5)).toBeNull()
    // 空 segments -> null（对应 seg 为 null 的兜底无锁定）
    expect(computeLoopSegment([], 3.0, 3.5)).toBeNull()
  })
})

describe('QA 独立回归 — BeatOverlay 数拍字移位到左上角', () => {
  function renderOverlay(beatIndex: number) {
    const container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)
    act(() => {
      root.render(<BeatOverlay beatIndex={beatIndex} pulse={false} total={8} />)
    })
    return { container, root }
  }

  it('根容器 className 改为左上角定位（top-0 left-0 items-start），不再居中', () => {
    const { container, root } = renderOverlay(3)
    const rootBox = container.querySelector('div')
    expect(rootBox).not.toBeNull()
    const cls = (rootBox as HTMLElement).className
    // 新位置类：左上角 + 顶部对齐
    expect(cls).toContain('top-0')
    expect(cls).toContain('left-0')
    expect(cls).toContain('items-start')
    expect(cls).toContain('p-4')
    // 旧的居中类必须消失
    expect(cls).not.toContain('inset-0')
    expect(cls).not.toContain('items-center')
    expect(cls).not.toContain('justify-center')
    root.unmount()
    container.remove()
  })

  it('beatIndex>0 时仍渲染大数字；beatIndex=0 时不渲染数字', () => {
    const { container, root } = renderOverlay(4)
    expect(container.textContent).toContain('4')
    root.unmount()
    container.remove()

    const c2 = document.createElement('div')
    document.body.appendChild(c2)
    const r2 = createRoot(c2)
    act(() => {
      r2.render(<BeatOverlay beatIndex={0} pulse={false} total={8} />)
    })
    // beatIndex=0 时大数字区域为空字符串（不显示数字）
    expect(c2.textContent).not.toMatch(/[1-8]/)
    r2.unmount()
    c2.remove()
  })
})
