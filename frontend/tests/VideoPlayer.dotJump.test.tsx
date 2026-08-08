// End-to-end test for the BeatOverlay dot -> segment jump (Plan A / 跳对应段).
// The overlay emits a 0-based dot index; the parent (LessonPage) converts it to
// a 1-based Segment.index via `goToSegment(i + 1)`. This test wires the SAME
// conversion and asserts the video actually seeks to the right section start —
// including the previously-dead first dot (0 -> segment 1) and the last dot
// (which was unreachable before the off-by-one fix).
import { describe, it, expect, afterEach, vi } from 'vitest'
import { createRef, type RefObject } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react'
import VideoPlayer from '../src/components/VideoPlayer'
import type { Segment } from '../src/types/api'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

// 5 contiguous 8-beat segments @ 120 BPM (0.5s/beat), 4s each.
// start times: 0, 4, 8, 12, 16.
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

function setup(opts: { segments: Segment[] }) {
  const videoRef = createRef<HTMLVideoElement>()
  const segments = opts.segments
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root: Root = createRoot(container)
  act(() => {
    root.render(
      <VideoPlayer
        src="dummy.mp4"
        mirror={false}
        beatMirror={false}
        videoRef={videoRef}
        beatIndex={1}
        pulse={false}
        // `total` makes the dot count equal the section count (Plan A fix).
        total={segments.length}
        // Mirror LessonPage's exact wiring: dot i (0-based) -> segment i+1 ->
        // that segment's start time. The seek is emulated via `seek`.
        onDotClick={(i: number) => {
          const seg = segments.find((s) => s.index === i + 1)
          if (seg && videoRef.current) {
            videoRef.current.currentTime = seg.startTime
          }
        }}
      />,
    )
  })
  // jsdom's HTMLMediaElement.currentTime is a no-op setter; make it observable.
  if (videoRef.current) {
    let cur = 0
    Object.defineProperty(videoRef.current, 'currentTime', {
      configurable: true,
      get: () => cur,
      set: (v: number) => {
        cur = v
      },
    })
  }
  return { container, root, videoRef }
}

describe('VideoPlayer dot → segment jump (end-to-end, Plan A)', () => {
  afterEach(() => {
    document.body.innerHTML = ''
  })

  it('dot i seeks to segment (i+1) start time, incl. first and last dots', () => {
    const { container, videoRef } = setup({ segments: makeSegments() })
    const dots = container.querySelectorAll('.rounded-full')
    expect(dots.length).toBe(5) // dot count == section count, not a fixed 8

    // dot 0 -> segment 1 -> start 0 (the previously DEAD first dot)
    act(() => {
      ;(dots[0] as HTMLElement).click()
    })
    expect(videoRef.current!.currentTime).toBe(0)

    // dot 2 -> segment 3 -> start 8 (no off-by-one skew)
    act(() => {
      ;(dots[2] as HTMLElement).click()
    })
    expect(videoRef.current!.currentTime).toBe(8)

    // last dot (4) -> segment 5 -> start 16 (previously UNREACHABLE)
    act(() => {
      ;(dots[4] as HTMLElement).click()
    })
    expect(videoRef.current!.currentTime).toBe(16)
  })

  it('emits the raw 0-based dot index (parent does the 1-based conversion)', () => {
    const segments = makeSegments()
    let emitted = -1
    const videoRef = createRef<HTMLVideoElement>()
    const container = document.createElement('div')
    document.body.appendChild(container)
    const root: Root = createRoot(container)
    act(() => {
      root.render(
        <VideoPlayer
          src="dummy.mp4"
          mirror={false}
          beatMirror={false}
          videoRef={videoRef}
          beatIndex={1}
          pulse={false}
          total={segments.length}
          onDotClick={(i: number) => {
            emitted = i
          }}
        />,
      )
    })
    const dots = container.querySelectorAll('.rounded-full')
    act(() => {
      ;(dots[0] as HTMLElement).click()
    })
    // BeatOverlay emits the 0-based index; the off-by-one is fixed at the
    // LessonPage wiring (`goToSegment(i + 1)`), not here.
    expect(emitted).toBe(0)
    document.body.innerHTML = ''
  })
})
