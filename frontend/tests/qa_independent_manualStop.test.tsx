/**
 * QA independent verification — "录制持续到手动停止" (drop the per-segment auto-stop).
 *
 * Requirement: the learner drills one phrase over and over. Recording must NOT
 * end when the teacher playhead crosses the segment end — it ends ONLY when the
 * learner presses 「停止录制」.
 *
 * These tests are written independently of the engineer's UI-level test. They
 * attack the same claim from three angles that a "click the button and look at
 * the DOM" test does not cover:
 *
 *   1. STRUCTURAL — no `timeupdate` listener is attached to the shared teacher
 *      <video> at all. The old auto-stop worked by subscribing to `timeupdate`;
 *      asserting the subscription never happens kills the regression at its
 *      root, independently of how far the fake playhead happens to be driven.
 *   2. RECORDER STATE — the MediaRecorder itself must still be in 'recording'
 *      after the boundary is crossed. The UI could in principle lag behind the
 *      recorder, so we assert the recorder, not just the button.
 *   3. REALISTIC DRILLING — loop back and forth across the bar line many times
 *      (12.1 -> 8 -> 12.1 ...), which is what practising actually looks like,
 *      rather than a single forward seek.
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

/** Records every instance so tests can inspect the real recorder state. */
const recorders: MockMediaRecorder[] = []
class MockMediaRecorder {
  state: 'inactive' | 'recording' = 'inactive'
  mimeType: string
  ondataavailable: ((e: { data: Blob }) => void) | null = null
  onstop: (() => void) | null = null
  constructor(_stream: MediaStream, opts?: { mimeType?: string }) {
    this.mimeType = opts?.mimeType ?? 'video/webm'
    recorders.push(this)
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
  recorders.length = 0
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

/**
 * Mirrors `LessonPage`: the teacher <video> is page-level. Its
 * `addEventListener` is spied so we can prove the auto-stop subscription is
 * gone rather than merely inert.
 */
function mount(props: Record<string, unknown>) {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const teacherVideoRef = createRef<HTMLVideoElement>()
  const listenerSpy = vi.fn()
  const root = createRoot(container)
  const Harness = () =>
    createElement(
      'div',
      null,
      createElement('video', {
        ref: (el: HTMLVideoElement | null) => {
          ;(teacherVideoRef as { current: HTMLVideoElement | null }).current = el
          if (el && !(el as unknown as { __spied?: boolean }).__spied) {
            ;(el as unknown as { __spied: boolean }).__spied = true
            const orig = el.addEventListener.bind(el)
            el.addEventListener = ((type: string, ...rest: unknown[]) => {
              listenerSpy(type)
              return (orig as unknown as (t: string, ...r: unknown[]) => void)(
                type,
                ...rest,
              )
            }) as typeof el.addEventListener
          }
        },
        'data-testid': 'teacher-video',
        src: '/video/abc',
      }),
      createElement(CompareMode, { ...props, teacherVideoRef }),
    )
  act(() => {
    root.render(createElement(Harness))
  })
  return {
    container,
    teacherVideoRef,
    listenerSpy,
    unmount: () => act(() => root.unmount()),
  }
}

async function flush() {
  await act(async () => {
    await new Promise((r) => setTimeout(r, 0))
  })
}

/** Always scope to the mount's own container: earlier tests leave DOM behind. */
function findButton(text: string, scope: ParentNode): HTMLButtonElement | undefined {
  return Array.from(scope.querySelectorAll('button')).find(
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

async function startRecording(container: HTMLElement) {
  const startBtn = findButton('开始录制', container)
  expect(startBtn).toBeTruthy()
  await act(async () => {
    startBtn!.click()
  })
  await flush()
}

describe('QA 独立回归 — 录制持续到手动停止', () => {
  it('结构性：录制期间不给老师视频挂 timeupdate 监听（自动停的根被拔掉）', async () => {
    mockCamera()
    const { container, listenerSpy } = mount(baseProps)
    await flush()
    await startRecording(container)

    const types = listenerSpy.mock.calls.map((c) => c[0] as string)
    // The old auto-stop subscribed to `timeupdate` in startRecording. If any
    // code path re-adds it, the recording could end on a bar line again.
    expect(types).not.toContain('timeupdate')
  })

  it('录制中反复跨小节边界（含来回循环）不会自动停，recorder 仍在 recording', async () => {
    mockCamera()
    const { container, teacherVideoRef } = mount(baseProps)
    await flush()
    await startRecording(container)

    expect(recorders).toHaveLength(1)
    expect(recorders[0].state).toBe('recording')

    const tv = teacherVideoRef.current!
    // Drill the phrase: play past the bar line, loop back, play past again…
    // Ten crossings of the 8..12 segment end — the old build would have
    // stopped on the very first one.
    await act(async () => {
      for (let i = 0; i < 5; i++) {
        for (const t of [11.9, 12, 12.1, 30, 8]) {
          tv.currentTime = t
          tv.dispatchEvent(new Event('timeupdate'))
          tv.dispatchEvent(new Event('seeked'))
        }
      }
      tv.dispatchEvent(new Event('ended'))
    })
    await flush()

    // Recorder-level assertion (not just the button).
    expect(recorders[0].state).toBe('recording')
    // UI-level: still offering STOP, never fell back to ready/review.
    expect(findButton('停止录制', container)).toBeTruthy()
    expect(findButton('开始录制', container)).toBeUndefined()
    expect(findButton('下载对比视频', container)).toBeUndefined()
    expect(
      container.querySelector('a[download="对比-小节3-my_lesson.webm"]'),
    ).toBeNull()
  })

  it('只有手动点「停止录制」才结束并产出下载链接', async () => {
    mockCamera()
    const { container, teacherVideoRef } = mount(baseProps)
    await flush()
    await startRecording(container)

    const tv = teacherVideoRef.current!
    await act(async () => {
      tv.currentTime = 45
      tv.dispatchEvent(new Event('timeupdate'))
    })
    await flush()
    expect(recorders[0].state).toBe('recording')

    await act(async () => {
      findButton('停止录制', container)!.click()
    })
    await flush()

    expect(recorders[0].state).toBe('inactive')
    expect(
      container.querySelector('a[download="对比-小节3-my_lesson.webm"]'),
    ).not.toBeNull()
    expect(findButton('重新录制', container)).toBeTruthy()
  })

  it('ready 阶段文案说明是持续录制／手动停止，不再承诺自动停', async () => {
    mockCamera()
    const { container } = mount(baseProps)
    await flush()
    const text = container.textContent ?? ''
    expect(text).toContain('持续录制')
    expect(text).toContain('手动停止')
    expect(text).not.toContain('自动停')
  })
})
