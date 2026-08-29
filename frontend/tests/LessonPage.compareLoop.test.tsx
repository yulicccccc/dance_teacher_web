import { act, createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { useLessonStore, type LoopMode } from '../src/store/lessonStore'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const useBeatSyncSpy = vi.hoisted(() =>
  vi.fn(() => ({ beatIndex: 1, pulse: false, activeSegment: 1, stepBeat: vi.fn() })),
)

vi.mock('../src/hooks/useBeatSync', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/hooks/useBeatSync')>()),
  useBeatSync: useBeatSyncSpy,
}))

vi.mock('../src/hooks/useLocalProgress', () => ({
  useLocalProgress: () => ({
    ready: false,
    getCourse: vi.fn(),
    saveCourse: vi.fn(),
    updateProgress: vi.fn(),
    markLearned: vi.fn(),
  }),
}))

vi.mock('../src/hooks/usePlayPauseSync', () => ({ usePlayPauseSync: vi.fn() }))

vi.mock('../src/components/VideoPlayer', async () => {
  const { createElement } = await import('react')
  return {
    default: ({ videoRef }: { videoRef: React.RefObject<HTMLVideoElement> }) =>
      createElement('video', { ref: videoRef, 'data-testid': 'teacher-video' }),
  }
})

vi.mock('../src/components/SegmentList', () => ({ default: () => null }))
vi.mock('../src/components/ProgressHeader', () => ({ default: () => null }))
vi.mock('../src/components/BeatInfoCard', () => ({ default: () => null }))
vi.mock('../src/components/CompareMode', () => ({
  default: () => createElement('div', { 'data-testid': 'compare-mode' }),
}))
vi.mock('../src/components/ControlBar', () => ({
  default: ({ onCompare }: { onCompare: () => void }) =>
    createElement('button', { 'data-testid': 'open-compare', onClick: onCompare }, '对照练习'),
}))

import LessonPage from '../src/pages/LessonPage'

async function renderLesson(loopMode: LoopMode) {
  useLessonStore.getState().reset()
  useLessonStore.setState({
    currentSegment: 1,
    loopEnabled: true,
    loopMode,
    loopSegmentIds: loopMode === 'multi' ? [1, 2] : [],
    abLoop:
      loopMode === 'ab'
        ? { enabled: true, aTime: 1, bTime: 3, aBeat: 1, bBeat: 5 }
        : null,
  })
  useBeatSyncSpy.mockClear()

  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  await act(async () => {
    root.render(
      createElement(
        MemoryRouter,
        { initialEntries: ['/lesson/demo'] },
        createElement(
          Routes,
          null,
          createElement(Route, { path: '/lesson/:taskId', element: createElement(LessonPage) }),
        ),
      ),
    )
    await new Promise((resolve) => setTimeout(resolve, 0))
  })

  const button = container.querySelector('[data-testid="open-compare"]') as HTMLButtonElement
  expect(button).not.toBeNull()
  act(() => button.click())

  return {
    latestBeatSyncArgs: useBeatSyncSpy.mock.calls.at(-1)!,
    cleanup: () => {
      act(() => root.unmount())
      container.remove()
    },
  }
}

describe('LessonPage — 对照录制保留循环', () => {
  beforeEach(() => useBeatSyncSpy.mockClear())

  for (const mode of ['single', 'multi', 'ab'] as const) {
    it(`${mode} 模式进入对照练习后循环引擎仍保持 active`, async () => {
      const { latestBeatSyncArgs, cleanup } = await renderLesson(mode)

      // useBeatSync 第 11 个参数是引擎 active 开关。对照录制复用同一个
      // teacher <video>，因此它必须继续为 true，三个循环模式才能照常回跳。
      expect(latestBeatSyncArgs[10]).toBe(true)

      cleanup()
    })
  }
})
