// QA 补测 — 点击左侧小节列表自动开启单节循环并锁定目标（LessonPage.goToSegment 修复）
//
// 复现并验证本次 bug 修复：单节循环模式下，用户点击左侧小节列表任一项，
// 应「点哪节就循环哪节」——自动开启单节循环（互斥清除 AB loop）并把循环目标
// 锁到点击的小节（依靠既有 forceLoopTargetRef 竞态修复机制）。
//
// 本测试在真实 LessonPage 组件上渲染，模拟点击小节项，断言：
//   1) 点击后 store.loopSegment === true（自动开启单节循环）、abLoop === null（互斥）。
//   2) store.currentSegment === 点击的小节编号。
//   3) useBeatSync 引擎把循环目标锁到点击小节：驱动播放头越过其 padded loopEnd 后，
//      回跳落点是该小节的 padded start（seg3 → 7.5），而非旧小节起点（seg1 → 0）。
//   4) multi 模式下点击小节「仅跳转」，不自动开启单节循环（loopSegment 保持 false）。
//
// 数据源通过 navigate state 直接注入 demoResult（本地零服务器模式，无需 getResult）。
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { createRef, type RefObject } from 'react'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import LessonPage from '../src/pages/LessonPage'
import { useLessonStore } from '../src/store/lessonStore'

// Flag the React act() environment so state updates flush correctly.
;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

// ---- Fake analysis result: 5 contiguous 8-beat segments @ 120 BPM (0.5s/beat), 4s each.
// seg1=[0,4) seg2=[4,8) seg3=[8,12) seg4=[12,16) seg5=[16,20)
// beatOffset=0 时 resegmentSegments 保持原网格不变（见 segmentMath 注释）。
function makeResult() {
  const segments = Array.from({ length: 5 }, (_, i) => {
    const start = i * 4
    return {
      index: i + 1,
      startTime: start,
      endTime: start + 4,
      type: 'dance' as const,
      beats: Array.from({ length: 8 }, (_, k) => start + k * 0.5),
    }
  })
  return {
    taskId: 'task1',
    videoName: 'demo',
    bpm: 120,
    confidence: 0.9,
    duration: 20,
    createdAt: new Date().toISOString(),
    segments,
  }
}

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
  // jsdom 不实现 <video> 的 play/pause（调用即抛 "Not implemented"），且
  // useVideoControls.play 的 `.catch` 兜底无法兜住同步抛错。无条件打桩成 no-op。
  HTMLMediaElement.prototype.play = (() =>
    Promise.resolve()) as unknown as HTMLMediaElement['play']
  HTMLMediaElement.prototype.pause = (() =>
    undefined) as unknown as HTMLMediaElement['pause']
})
afterEach(() => {
  globalThis.requestAnimationFrame = realRaf
  globalThis.cancelAnimationFrame = realCaf
  localStorage.clear()
  useLessonStore.getState().reset()
})
function flushRaf() {
  const cbs = rafQueue
  rafQueue = []
  for (const cb of cbs) cb(performance.now())
}
function step() {
  act(() => {
    flushRaf()
  })
}

// 记录 <video>.currentTime 的所有赋值，用于观测引擎发起的 loop-back 回跳。
let timeLog: number[] = []
function installTimeSpy(video: HTMLVideoElement) {
  timeLog = []
  Object.defineProperty(video, 'currentTime', {
    configurable: true,
    get() {
      return (this as unknown as { __t?: number }).__t ?? 0
    },
    set(v: number) {
      ;(this as unknown as { __t?: number }).__t = v
      timeLog.push(v)
    },
  })
}

// 通过小节文案定位左侧小节按钮（MUI ListItemButton → role="button"）。
function findSegmentButton(
  container: HTMLElement,
  index: number,
  total: number,
): HTMLElement {
  const buttons = Array.from(
    container.querySelectorAll<HTMLElement>('[role="button"]'),
  )
  const target = buttons.find((b) =>
    b.textContent?.includes(`${index} / ${total} 小节`),
  )
  if (!target) throw new Error(`segment button ${index} not found`)
  return target
}

async function waitForText(
  container: HTMLElement,
  text: string,
  timeout = 12000,
): Promise<void> {
  const start = Date.now()
  while (Date.now() - start < timeout) {
    if (container.textContent?.includes(text)) return
    await act(async () => {
      await new Promise((r) => setTimeout(r, 10))
    })
  }
  throw new Error(`timeout waiting for text: ${text}`)
}

describe('QA — 点击小节自动开启单节循环并锁定目标', () => {
  it('单节循环模式：点击第 3 节应自动开启单节循环，并把循环锁到第 3 节（回跳落点 7.5，而非 0）', { timeout: 20000 }, async () => {
    useLessonStore.getState().reset() // loopMode='single', loopSegment=false
    expect(useLessonStore.getState().loopSegment).toBe(false)

    const container = document.createElement('div')
    document.body.appendChild(container)
    const root: Root = createRoot(container)

    await act(async () => {
      root.render(
        <MemoryRouter
          initialEntries={[
            { pathname: '/lesson/task1', state: { videoId: 'v1', demoResult: makeResult() } },
          ]}
        >
          <Routes>
            <Route path="/lesson/:taskId" element={<LessonPage />} />
          </Routes>
        </MemoryRouter>,
      )
    })

    // 等待结果加载 + 小节列表渲染出来。
    await waitForText(container, '1 / 5 小节')

    const video = container.querySelector('video') as HTMLVideoElement | null
    expect(video).not.toBeNull()
    installTimeSpy(video as HTMLVideoElement)

    // 让引擎先跑一帧（此时 loopSegment=false，仅刷新 prevTimeRef，不锁定）。
    step()

    // 点击左侧小节列表第 3 节（真实 onClick 走 goToSegment）。
    const btn = findSegmentButton(container, 3, 5)
    await act(async () => {
      btn.dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
    })

    // —— 断言 1：自动开启单节循环（互斥清除 AB loop）——
    expect(useLessonStore.getState().loopSegment).toBe(true)
    expect(useLessonStore.getState().abLoop).toBeNull()
    // —— 断言 2：currentSegment 切到点击的小节 ——
    expect(useLessonStore.getState().currentSegment).toBe(3)

    // 让引擎消化 forceLoopTargetRef（tick 在下一帧最开头把循环目标切到第 3 节）。
    step()

    // —— 断言 3：驱动播放头越过 seg3 的 padded loopEnd(12.5) ——
    timeLog.length = 0
    act(() => {
      ;(video as HTMLVideoElement).currentTime = 13.0
    })
    step() // tick 检测越过 loopEnd → 回跳到 seg3 padded start 7.5

    // 回跳落点应是 seg3 的 padded start 7.5（绝不回跳到旧 seg1 起点 0）。
    expect(Math.abs((video as HTMLVideoElement).currentTime - 7.5) < 1e-3).toBe(true)
    // 收集到的引擎回跳目标里包含 7.5，且不含 0（旧小节）。
    expect(timeLog.some((t) => Math.abs(t - 7.5) < 1e-3)).toBe(true)
    expect(timeLog.some((t) => Math.abs(t) < 1e-3)).toBe(false)

    root.unmount()
    container.remove()
  })

  it('multi 模式：点击小节仅跳转，不自动开启单节循环（loopSegment 保持 false）', { timeout: 20000 }, async () => {
    useLessonStore.getState().reset()
    useLessonStore.setState({ loopMode: 'multi', loopSegment: false })

    const container = document.createElement('div')
    document.body.appendChild(container)
    const root: Root = createRoot(container)

    await act(async () => {
      root.render(
        <MemoryRouter
          initialEntries={[
            { pathname: '/lesson/task1', state: { videoId: 'v1', demoResult: makeResult() } },
          ]}
        >
          <Routes>
            <Route path="/lesson/:taskId" element={<LessonPage />} />
          </Routes>
        </MemoryRouter>,
      )
    })

    await waitForText(container, '1 / 5 小节')

    const btn = findSegmentButton(container, 3, 5)
    await act(async () => {
      btn.dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
    })

    // multi 模式维持既有行为：仅跳转，不自动开启单节循环。
    expect(useLessonStore.getState().loopSegment).toBe(false)
    expect(useLessonStore.getState().currentSegment).toBe(3)

    root.unmount()
    container.remove()
  })
})
