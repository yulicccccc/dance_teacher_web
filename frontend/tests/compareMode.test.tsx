import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest'
import { createRoot } from 'react-dom/client'
import { act } from 'react'
import { createElement, createRef } from 'react'
import CompareMode from '../src/components/CompareMode'
import {
  resolveCompareSegment,
  compareFileName,
  pickMimeType,
} from '../src/utils/compare'
import type { Segment } from '../src/types/api'

const comparisonAudioMock = vi.hoisted(() => ({
  track: { kind: 'audio', id: 'mixed-count-track' } as MediaStreamTrack,
  cleanup: vi.fn(),
  prepare: vi.fn(),
  play: vi.fn(),
}))

vi.mock('../src/audio/countVoiceAudio', () => ({
  prepareComparisonAudio: comparisonAudioMock.prepare,
  playCountVoice: comparisonAudioMock.play,
}))

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
let canvasAddTrackSpy: ReturnType<typeof vi.fn>
let ctxStub: {
  fillStyle: string
  font: string
  fillRect: ReturnType<typeof vi.fn>
  fillText: ReturnType<typeof vi.fn>
  drawImage: ReturnType<typeof vi.fn>
  save: ReturnType<typeof vi.fn>
  restore: ReturnType<typeof vi.fn>
  beginPath: ReturnType<typeof vi.fn>
  rect: ReturnType<typeof vi.fn>
  clip: ReturnType<typeof vi.fn>
  translate: ReturnType<typeof vi.fn>
  scale: ReturnType<typeof vi.fn>
}

beforeAll(() => {
  // rAF no-op so the draw loop body never runs (it only paints the canvas).
  realRaf = globalThis.requestAnimationFrame
  realCaf = globalThis.cancelAnimationFrame
  globalThis.requestAnimationFrame = (() => 0) as unknown as typeof requestAnimationFrame
  globalThis.cancelAnimationFrame = (() => {}) as typeof cancelAnimationFrame

  realMediaRecorder = (globalThis as unknown as { MediaRecorder?: unknown }).MediaRecorder
  ;(globalThis as unknown as { MediaRecorder: unknown }).MediaRecorder = MockMediaRecorder

  ctxStub = {
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
  ).captureStream = () => {
    canvasAddTrackSpy = vi.fn()
    return ({ addTrack: canvasAddTrackSpy, getAudioTracks: () => [] }) as unknown as MediaStream
  }

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

beforeEach(() => {
  comparisonAudioMock.cleanup.mockClear()
  comparisonAudioMock.play.mockReset()
  comparisonAudioMock.play.mockResolvedValue(undefined)
  comparisonAudioMock.prepare.mockReset()
  comparisonAudioMock.prepare.mockResolvedValue({
    track: comparisonAudioMock.track,
    cleanup: comparisonAudioMock.cleanup,
  })
  ctxStub.fillText.mockClear()
  ctxStub.scale.mockClear()
})

afterAll(() => {
  globalThis.requestAnimationFrame = realRaf
  globalThis.cancelAnimationFrame = realCaf
  ;(globalThis as unknown as { MediaRecorder: unknown }).MediaRecorder = realMediaRecorder
  URL.createObjectURL = realCreateObjectURL
  URL.revokeObjectURL = realRevokeObjectURL
})

/** Returns the (stable) fake camera track so tests can assert it gets stopped. */
function mockCamera(resolved: boolean) {
  const track = { stop: vi.fn() }
  const fakeStream = {
    getTracks: () => [track],
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
  return track
}

// ---- render helpers -------------------------------------------------------
/**
 * `CompareMode` no longer owns a teacher <video>: it reuses the page-level
 * element (the same one the control bar drives). The harness therefore renders
 * that element itself and hands the ref down, mirroring `LessonPage`.
 */
function mount(ui: Parameters<typeof createElement>[1]) {
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
      createElement(CompareMode, {
        ...(ui as Record<string, unknown>),
        teacherVideoRef,
      }),
    )
  act(() => {
    root.render(createElement(Harness))
  })
  return {
    root,
    container,
    teacherVideoRef,
    unmount: () => act(() => root.unmount()),
  }
}

async function flush() {
  await act(async () => {
    await new Promise((r) => setTimeout(r, 0))
  })
}

/**
 * Find a button by exact label. `scope` defaults to the whole document for the
 * older tests; pass the mount's own `container` when asserting the ABSENCE of a
 * button, since previous tests in this file leave their DOM mounted.
 */
function findButton(text: string, scope: ParentNode = document): HTMLButtonElement | undefined {
  return Array.from(scope.querySelectorAll('button')).find(
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

  it('renders in place (no modal dialog) so the page controls stay reachable', async () => {
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
    // A MUI Dialog would render a [role="dialog"] portal into <body> and trap
    // focus, hiding the segment list / control bar behind a backdrop.
    expect(document.querySelector('[role="dialog"]')).toBeNull()
    expect(document.querySelector('[data-testid="compare-panel"]')).not.toBeNull()
    expect(document.querySelector('[data-testid="compare-canvas"]')).not.toBeNull()
  })

  it('stops the camera tracks when the panel is unmounted (exit compare)', async () => {
    const track = mockCamera(true)
    const { unmount } = mount({
      open: true,
      onClose: () => {},
      src: '/video/abc',
      segment: seg(3, 8, 12),
      segmentIndex: 3,
      mirror: true,
      videoName: 'my lesson',
    })
    await flush()
    expect(track.stop).not.toHaveBeenCalled()
    unmount()
    expect(track.stop).toHaveBeenCalled()
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

  it('keeps recording past the segment end — only a manual stop ends it', async () => {
    mockCamera(true)
    // Scope every query to THIS mount: earlier tests leave their DOM in <body>,
    // so a document-wide search would see their stale "开始录制" buttons.
    const { container } = mount({
      open: true,
      onClose: () => {},
      src: '/video/abc',
      segment: seg(3, 8, 12),
      segmentIndex: 3,
      mirror: true,
      videoName: 'my lesson',
    })
    await flush()

    const startBtn = findButton('开始录制', container)
    expect(startBtn).toBeTruthy()
    await act(async () => {
      startBtn!.click()
    })
    await flush()

    // recording phase
    expect(findButton('停止录制', container)).toBeTruthy()

    // Drive the teacher playhead WELL past the segment end (8..12) and fire
    // timeupdate repeatedly — the learner is drilling the phrase over and over,
    // so the recording must keep running instead of auto-stopping at the bar
    // line the way it used to.
    const tv = container.querySelector(
      '[data-testid="teacher-video"]',
    ) as HTMLVideoElement
    await act(async () => {
      tv.currentTime = 12.1
      tv.dispatchEvent(new Event('timeupdate'))
      tv.currentTime = 30
      tv.dispatchEvent(new Event('timeupdate'))
    })
    await flush()

    expect(findButton('停止录制', container)).toBeTruthy()
    expect(findButton('开始录制', container)).toBeUndefined()
    expect(
      container.querySelector('a[download="对比-小节3-my_lesson.webm"]'),
    ).toBeNull()

    // Manual stop -> review phase with the download link.
    await act(async () => {
      findButton('停止录制', container)!.click()
    })
    await flush()

    const a = container.querySelector('a[download="对比-小节3-my_lesson.webm"]')
    expect(a).not.toBeNull()
  })

  it('draws the live beat counter into the same canvas that becomes the recording', async () => {
    mockCamera(true)
    let frame: FrameRequestCallback | null = null
    const previousRaf = globalThis.requestAnimationFrame
    globalThis.requestAnimationFrame = ((callback: FrameRequestCallback) => {
      frame = callback
      return 1
    }) as typeof requestAnimationFrame

    const { container, teacherVideoRef } = mount({
      open: true,
      onClose: () => {},
      src: '/video/abc',
      segment: seg(3, 8, 12),
      segmentIndex: 3,
      mirror: true,
      beatIndex: 4,
      pulse: true,
      beatMirror: false,
      videoName: 'my lesson',
    })
    await flush()
    const camera = container.querySelector('[data-testid="compare-panel"] video') as HTMLVideoElement
    Object.defineProperty(teacherVideoRef.current!, 'videoWidth', { configurable: true, value: 640 })
    Object.defineProperty(teacherVideoRef.current!, 'videoHeight', { configurable: true, value: 360 })
    Object.defineProperty(camera, 'videoWidth', { configurable: true, value: 640 })
    Object.defineProperty(camera, 'videoHeight', { configurable: true, value: 360 })

    act(() => frame?.(0))
    expect(ctxStub.fillText).toHaveBeenCalledWith('4', expect.any(Number), expect.any(Number))
    expect(container.querySelector('[data-testid="compare-canvas"]')).not.toBeNull()
    globalThis.requestAnimationFrame = previousRaf
  })

  it('adds the shared teacher + count-command audio mix to the recorded canvas stream', async () => {
    mockCamera(true)
    const { container, teacherVideoRef } = mount({
      open: true,
      onClose: () => {},
      src: '/video/abc',
      segment: seg(3, 8, 12),
      segmentIndex: 3,
      mirror: true,
      videoName: 'my lesson',
    })
    await flush()

    await act(async () => findButton('开始录制', container)!.click())
    await flush()
    expect(comparisonAudioMock.prepare).toHaveBeenCalledWith(teacherVideoRef.current)
    expect(canvasAddTrackSpy).toHaveBeenCalledWith(comparisonAudioMock.track)

    await act(async () => findButton('停止录制', container)!.click())
    await flush()
    expect(comparisonAudioMock.cleanup).toHaveBeenCalled()
  })

  it('replays the first count when recording starts on an already-selected beat', async () => {
    mockCamera(true)
    const segment = {
      ...seg(3, 8, 12),
      startBeat: 5,
      beats: [8, 8.5, 9, 9.5],
    }
    const { container } = mount({
      open: true,
      onClose: () => {},
      src: '/video/abc',
      segment,
      segmentIndex: 3,
      mirror: true,
      beatIndex: 5,
      voiceEnabled: true,
      voiceVolume: 1.6,
      videoName: 'my lesson',
    })
    await flush()

    await act(async () => findButton('开始录制', container)!.click())
    await flush()
    expect(comparisonAudioMock.play).toHaveBeenCalledWith(5, 1.6)
  })

  it('offers an actual recording mirror before capture and a review mirror afterwards', async () => {
    mockCamera(true)
    const { container } = mount({
      open: true,
      onClose: () => {},
      src: '/video/abc',
      segment: seg(3, 8, 12),
      segmentIndex: 3,
      mirror: true,
      videoName: 'my lesson',
    })
    await flush()
    expect(findButton('录制镜像', container)).toBeTruthy()

    await act(async () => findButton('开始录制', container)!.click())
    await flush()
    await act(async () => findButton('停止录制', container)!.click())
    await flush()

    const review = container.querySelector('[data-testid="review-video"]') as HTMLVideoElement
    expect(review.style.transform).toBe('none')
    expect(review.classList.contains('review-video--mirrored')).toBe(false)
    act(() => findButton('回看镜像', container)!.click())
    expect(review.style.transform).toBe('scaleX(-1)')
    expect(review.classList.contains('review-video--mirrored')).toBe(true)
  })

  it('ticks the 录制中 elapsed badge while recording and clears it on stop', async () => {
    mockCamera(true)
    const { container } = mount({
      open: true,
      onClose: () => {},
      src: '/video/abc',
      segment: seg(3, 8, 12),
      segmentIndex: 3,
      mirror: true,
      videoName: 'my lesson',
    })
    await flush()

    await act(async () => {
      findButton('开始录制', container)!.click()
    })
    await flush()

    const elapsedOf = (): number => {
      const m = /录制中 · (\d+\.\d)s/.exec(container.textContent ?? '')
      expect(m, 'recording badge should be on screen').not.toBeNull()
      return parseFloat(m![1])
    }
    // Badge starts at zero...
    expect(elapsedOf()).toBe(0)

    // ...and advances on its own. The interval ticks every 100ms, so a 250ms
    // window is enough to see it move. (Regression guard: `timerRef` used to be
    // cleared but never *set*, so the badge was frozen at 0.0s forever — which
    // now matters much more since recordings run for minutes, not one bar.)
    const clearSpy = vi.spyOn(window, 'clearInterval')
    await act(async () => {
      await new Promise((r) => setTimeout(r, 250))
    })
    expect(elapsedOf()).toBeGreaterThan(0)

    // Stopping tears the interval down so it cannot leak past the recording.
    await act(async () => {
      findButton('停止录制', container)!.click()
    })
    await flush()
    expect(clearSpy).toHaveBeenCalled()
    clearSpy.mockRestore()
    expect(container.textContent).not.toContain('录制中')
  })
})
