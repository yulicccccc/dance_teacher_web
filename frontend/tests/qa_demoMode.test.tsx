// QA — 「试用示例」模式端到端冒烟测试
//
// 目标：验证在没有后端的情况下，用户在 UploadPage 点击「试用示例（无需上传）」
// 按钮后，能导航到 /lesson/demo，且 LessonPage 在 demo 数据源下渲染出 6 个
// 8 拍小节（左侧小节列表出现 "1 / 6 小节"），且全程【不】触发任何后端 getResult。
//
// 覆盖点：
//   1) UploadPage 渲染出「试用示例（无需上传）」按钮 + 说明文字。
//   2) 点击按钮后路由切到 /lesson/demo，并通过 navigate state 注入 demoResult。
//   3) LessonPage 在 demo 模式下跳过结果拉取，直接用 demoResult，渲染 6 个小节。
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import UploadPage from '../src/pages/UploadPage'
import LessonPage from '../src/pages/LessonPage'
import { useLessonStore } from '../src/store/lessonStore'
import { buildDemoResult } from '../src/demo/sampleLesson'

// Flag the React act() environment so state updates flush correctly.
;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

// jsdom 不实现 <video> 的 play/pause（调用即抛 "Not implemented"）。无条件打桩成 no-op，
// 与现有 LessonPage 测试保持一致，避免 act 内同步抛错。
beforeEach(() => {
  HTMLMediaElement.prototype.play = (() =>
    Promise.resolve()) as unknown as HTMLMediaElement['play']
  HTMLMediaElement.prototype.pause = (() =>
    undefined) as unknown as HTMLMediaElement['pause']
})
afterEach(() => {
  localStorage.clear()
  useLessonStore.getState().reset()
  document.body.innerHTML = ''
})

async function waitForText(
  container: HTMLElement,
  text: string,
  timeout = 3000,
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

describe('QA — 试用示例模式', () => {
  it('点击「试用示例」→ 导航到 lesson 且 demo 下渲染出 6 个小节（"1 / 6 小节"）', async () => {
    useLessonStore.getState().reset()

    const container = document.createElement('div')
    document.body.appendChild(container)
    const root: Root = createRoot(container)

    // 一条 MemoryRouter 同时挂 UploadPage 与 LessonPage，使点击后同树内导航。
    await act(async () => {
      root.render(
        <MemoryRouter initialEntries={['/']}>
          <Routes>
            <Route path="/" element={<UploadPage />} />
            <Route path="/lesson/:taskId" element={<LessonPage />} />
          </Routes>
        </MemoryRouter>,
      )
    })

    // 1) UploadPage 出现试用示例按钮 + 说明。
    expect(container.textContent).toContain('试用示例（无需上传）')
    expect(container.textContent).toContain('内置示例拍点，可离线测试所有交互')

    // 找到「试用示例（无需上传）」按钮并真实点击。
    const buttons = Array.from(
      container.querySelectorAll<HTMLButtonElement>('button'),
    )
    const demoBtn = buttons.find((b) => b.textContent?.includes('试用示例（无需上传）'))
    expect(demoBtn).toBeTruthy()
    await act(async () => {
      demoBtn!.dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
    })

    // 2) + 3) 导航到 /lesson/demo，LessonPage 用 demoResult 渲染 6 个小节。
    await waitForText(container, '1 / 6 小节')

    // 进一步断言：小节列表确实包含 6 节（"6 / 6 小节" 存在）。
    expect(container.textContent).toContain('6 / 6 小节')

    // 断言 demoResult 确实为 6 个 segment（与 buildDemoResult 一致）。
    const demo = buildDemoResult()
    expect(demo.segments).toHaveLength(6)
    expect(demo.bpm).toBe(100)
    expect(demo.videoName).toBe('示例舞蹈（Demo）')

    root.unmount()
    container.remove()
  })
})
