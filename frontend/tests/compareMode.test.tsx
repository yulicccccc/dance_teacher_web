import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react'
import { createElement } from 'react'
import CompareMode from '../src/components/CompareMode'
import {
  resolveCompareSegment,
  shouldAutoStop,
  compareFileName,
  pickMimeType,
} from '../src/utils/compare'
import type { Segment } from '../src/types/api'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const seg = (i: number, start: number, end: number): Segment => ({
  index: i,
  startTime: start,
  endTime: end,
  type: 'dance',
  beats: [],
})

// ---- media mocks ----------------------------------------------------------
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
  // rAF no-op so the draw loop body never runs (we drive auto-stop via timeupdate).
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
  ;(HTMLCanvasElement.prototype as unknown as { getContext: () => unknown }).getContext = () =>
    ctxStub
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

  if (!window.matchMedia) {
    window.matchMedia = ((q: string) => ({
      matches: false,
      media: q,
      onchange: null,
      addListener: () => {},
      removeListener: () => {},
      addEventListener: () => {},
      removeEventListener: () => {},
      dispatchEvent: () => false,
    })) as unknown as typeof window.matchMedia
  }
})

afterAll(() => {
  globalThis.requestAnimationFrame = realRaf
  globalThis.cancelAnimationFrame = realCaf
  ;(globalThis as unknown as { MediaRecorder: unknown }).MediaRecorder = realMediaRecorder
  URL.createObjectURL = realCreateObjectURL
  URL.revokeObjectURL = realRevokeObjectURL
})

function mockCamera(resolved: boolean) {
  const fakeStream = {
    getTracks: () => [{ stop: vi.fn() }],
    getAudioTracks: () => [],
  }
  Object.defineProperty(navigator, 'mediaDevices', {
    configurable: true,
    value: {
      getUserMedia: resolved
        ? vi.fn().mockResolvedValue(fakeStream)
        : vi.fn().mockRejectedValue(
            Object.assign(new Error('denied'), { name: 'NotAllowedError' }),
          ),
    },
  })
}

// ---- render helpers -------------------------------------------------------
function mount(ui: Parameters<typeof createElement>[1]) {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  act(() => {
    root.render(createElement(CompareMode, ui as Record<string, unknown>))
  })
  return {
    root,
    unmount: () => act(() => root.unmount()),
  }
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

// ---- pure helpers ---------------------------------------------------------
describe('compare utils', () => {
  it('resolveCompareSegment picks the current segment', () => {
    const segs = [seg(1, 0, 4), seg(2, 4, 8), seg(3, 8, 12)]
    expect(resolveCompareSegment(segs, 2)?.index).toBe(2)
    expect(resolveCompareSegment(segs, 99)?.index).toBe(1)
    expect(resolveCompareSegment([], 1)).toBeNull()
  })

  it('shouldAutoStop triggers at/after segment end', () => {
    expect(shouldAutoStop(12, 12)).toBe(true)
    expect(shouldAutoStop(11.9, 12)).toBe(false)
    expect(shouldAutoStop(11.96, 12, 0.05)).toBe(true)
    expect(shouldAutoStop(100, 12)).toBe(true)
  })

  it('compareFileName is filesystem-safe', () => {
    expect(compareFileName('my lesson', 3)).toBe('对比-小节3-my_lesson.webm')
    expect(compareFileName('a/b:c*?', 1)).toBe('对比-小节1-a_b_c_.webm')
  })

  it('pickMimeType returns a supported webm type', () => {
    expect(pickMimeType()).toContain('webm')
  })
})

// ---- component ------------------------------------------------------------
describe('CompareMode', () => {
  it('shows the start button once the camera is granted', async () => {
    mockCamera(true)
    mount({
      open: true,
      onClose: () => {},
      src: '/video/abc',
      segment: seg(3, 8, 12),
      segmentIndex: 3,
      mirror: true,
      videoName: 'my lesson',
    })
    await flush()
    expect(findButton('开始录制')).toBeTruthy()
  })

  it('shows an error when camera permission is denied', async () => {
    mockCamera(false)
    mount({
      open: true,
      onClose: () => {},
      src: '/video/abc',
      segment: seg(3, 8, 12),
      segmentIndex: 3,
      mirror: true,
      videoName: 'my lesson',
    })
    await flush()
    expect(document.body.textContent).toContain('摄像头权限被拒绝')
  })

  it('records then auto-stops at segment end and offers a download', async () => {
    mockCamera(true)
    mount({
      open: true,
      onClose: () => {},
      src: '/video/abc',
      segment: seg(3, 8, 12),
      segmentIndex: 3,
      mirror: true,
      videoName: 'my lesson',
    })
    await flush()

    const startBtn = findButton('开始录制')
    expect(startBtn).toBeTruthy()
    await act(async () => {
      startBtn!.click()
    })
    await flush()

    // recording phase
    expect(findButton('停止录制')).toBeTruthy()

    // drive the teacher playhead past the segment end and fire timeupdate
    const tv = document.querySelector(
      '[data-testid="teacher-video"]',
    ) as HTMLVideoElement
    await act(async () => {
      tv.currentTime = 12.1
      tv.dispatchEvent(new Event('timeupdate'))
    })
    await flush()

    // review phase: download link with the right filename
    const a = document.querySelector('a[download="对比-小节3-my_lesson.webm"]')
    expect(a).not.toBeNull()
  })
})
