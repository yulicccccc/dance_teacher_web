/**
 * QA independent verification — "对照练习" inline split-screen refactor.
 *
 * These tests were added by QA (not the implementing engineer) after mutation
 * testing showed a gap: hard-coding `tv.playbackRate = 1` inside
 * `CompareMode.startRecording` left the whole 147-test suite green, i.e. the
 * claim "the comparison records at the speed picked on the control-bar slider"
 * was NOT locked by any assertion.
 *
 * They pin the two structural guarantees that make the inline panel correct:
 *   1. recording speed comes from the SHARED store (`useLessonStore.playbackRate`),
 *      the same source the bottom control bar writes to;
 *   2. the panel does not mount a private teacher `<video>` — it reuses the
 *      page-level element handed down through `teacherVideoRef`.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest'
import { createRoot } from 'react-dom/client'
import { act } from 'react'
import { createElement, createRef } from 'react'
import CompareMode from '../src/components/CompareMode'
import { useLessonStore } from '../src/store/lessonStore'
import type { Segment } from '../src/types/api'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true

const seg = (i: number, start: number, end: number): Segment => ({
  index: i,
  startTime: start,
  endTime: end,
  type: 'dance',
  beats: [],
})

class MockMediaRecorder {
  state: 'inactive' | 'recording' = 'inactive'
  mimeType: string
  ondataavailable: ((e: { data: Blob }) => void) | null = null
  onstop: (() => void) | null = null
  constructor(_stream: MediaStream, opts?: { mimeType?: string }) {
    this.mimeType = opts?.mimeType ?? 'video/webm'
  }
  start() {
    this.state = 'recording'
  }
  stop() {
    if (this.state === 'inactive') return
    this.state = 'inactive'
    this.onstop?.()
  }
  static isTypeSupported = () => true
}

let realRaf: typeof requestAnimationFrame
let realCaf: typeof cancelAnimationFrame
let realMediaRecorder: unknown
let realCreateObjectURL: typeof URL.createObjectURL
let realRevokeObjectURL: typeof URL.revokeObjectURL

beforeAll(() => {
  realRaf = globalThis.requestAnimationFrame
  realCaf = globalThis.cancelAnimationFrame
  globalThis.requestAnimationFrame = (() => 0) as unknown as typeof requestAnimationFrame
  globalThis.cancelAnimationFrame = (() => {}) as typeof cancelAnimationFrame

  realMediaRecorder = (globalThis as unknown as { MediaRecorder?: unknown }).MediaRecorder
  ;(globalThis as unknown as { MediaRecorder: unknown }).MediaRecorder = MockMediaRecorder

  const ctxStub = {
    fillStyle: '',
    font: '',
    fillRect: vi.fn(),
    fillText: vi.fn(),
    drawImage: vi.fn(),
    save: vi.fn(),
    restore: vi.fn(),
    beginPath: vi.fn(),
    rect: vi.fn(),
    clip: vi.fn(),
    translate: vi.fn(),
    scale: vi.fn(),
  }
  ;(HTMLCanvasElement.prototype as unknown as { getContext: () => unknown }).getContext =
    () => ctxStub
  ;(
    HTMLCanvasElement.prototype as unknown as { captureStream: () => unknown }
  ).captureStream = () =>
    ({ addTrack: vi.fn(), getAudioTracks: () => [] }) as unknown as MediaStream
  ;(window.HTMLMediaElement.prototype as unknown as { play: () => Promise<void> }).play =
    () => Promise.resolve()
  ;(window.HTMLMediaElement.prototype as unknown as { pause: () => void }).pause = () => {}
  ;(window.HTMLMediaElement.prototype as unknown as { load: () => void }).load = () => {}

  realCreateObjectURL = URL.createObjectURL
  realRevokeObjectURL = URL.revokeObjectURL
  URL.createObjectURL = () => 'blob:mock'
  URL.revokeObjectURL = () => {}
})

afterAll(() => {
  globalThis.requestAnimationFrame = realRaf
  globalThis.cancelAnimationFrame = realCaf
  ;(globalThis as unknown as { MediaRecorder: unknown }).MediaRecorder = realMediaRecorder
  URL.createObjectURL = realCreateObjectURL
  URL.revokeObjectURL = realRevokeObjectURL
})

beforeEach(() => {
  useLessonStore.getState().reset()
})

function mockCamera() {
  const track = { stop: vi.fn() }
  Object.defineProperty(navigator, 'mediaDevices', {
    configurable: true,
    value: {
      getUserMedia: vi
        .fn()
        .mockResolvedValue({ getTracks: () => [track], getAudioTracks: () => [] }),
    },
  })
  return track
}

/** Mirrors `LessonPage`: the teacher <video> lives on the PAGE, not in the panel. */
function mount(props: Record<string, unknown>) {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const teacherVideoRef = createRef<HTMLVideoElement>()
  const root = createRoot(container)
  const Harness = () =>
    createElement(
      'div',
      null,
      createElement('video', {
        ref: teacherVideoRef,
        'data-testid': 'teacher-video',
        src: '/video/abc',
      }),
      createElement(CompareMode, { ...props, teacherVideoRef }),
    )
  act(() => {
    root.render(createElement(Harness))
  })
  return { container, teacherVideoRef, unmount: () => act(() => root.unmount()) }
}

async function flush() {
  await act(async () => {
    await new Promise((r) => setTimeout(r, 0))
  })
}

function findButton(text: string): HTMLButtonElement | undefined {
  return Array.from(document.querySelectorAll('button')).find(
    (b) => b.textContent === text,
  ) as HTMLButtonElement | undefined
}

const baseProps = {
  open: true,
  onClose: () => {},
  src: '/video/abc',
  segment: seg(3, 8, 12),
  segmentIndex: 3,
  mirror: true,
  videoName: 'my lesson',
}

describe('QA 独立回归 — 对照练习内联分屏', () => {
  it('录制使用控制条（store）选定的倍速，而不是写死的 1x', async () => {
    mockCamera()
    // The learner drags the control-bar speed slider to 0.5x BEFORE recording.
    act(() => {
      useLessonStore.getState().setPlaybackRate(0.5)
    })
    const { teacherVideoRef } = mount(baseProps)
    await flush()

    const startBtn = findButton('开始录制')
    expect(startBtn).toBeTruthy()
    await act(async () => {
      startBtn!.click()
    })
    await flush()

    // The shared page-level teacher <video> must be driven at the store speed.
    expect(teacherVideoRef.current!.playbackRate).toBe(0.5)
  })

  it('倍速文案与 store 同源（滑条改动即时反映在面板上）', async () => {
    mockCamera()
    act(() => {
      useLessonStore.getState().setPlaybackRate(0.75)
    })
    mount(baseProps)
    await flush()
    expect(document.body.textContent).toContain('0.75x')
  })

  it('面板内不自建老师 <video>，只复用页面级元素（内部仅一个无 src 的摄像头元素）', async () => {
    mockCamera()
    mount(baseProps)
    await flush()

    const panel = document.querySelector('[data-testid="compare-panel"]')!
    expect(panel).not.toBeNull()
    const videos = Array.from(panel.querySelectorAll('video'))
    // Only the hidden camera sink lives inside the panel; a private teacher
    // video would carry the lesson `src` and desync from the control bar.
    expect(videos).toHaveLength(1)
    expect(videos[0].getAttribute('src')).toBeNull()
    expect(videos.some((v) => v.getAttribute('src') === '/video/abc')).toBe(false)
    // The page-level teacher element is OUTSIDE the panel and untouched.
    const teacher = document.querySelector('[data-testid="teacher-video"]')!
    expect(panel.contains(teacher)).toBe(false)
    expect(teacher.getAttribute('src')).toBe('/video/abc')
  })

  it('退出对照后不清空页面播放器的 src（控制条仍可驱动同一元素）', async () => {
    mockCamera()
    const { teacherVideoRef, unmount } = mount(baseProps)
    await flush()
    const teacher = teacherVideoRef.current!
    teacher.currentTime = 9.5
    unmount()
    // The main player belongs to the page: unmounting the panel must not
    // detach its source (the old modal-owned teacher video called load()).
    expect(teacher.getAttribute('src')).toBe('/video/abc')
    expect(teacher.currentTime).toBe(9.5)
  })
})
