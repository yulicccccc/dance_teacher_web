import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createRef } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react'
import VideoPlayer from '../src/components/VideoPlayer'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

// Make getBoundingClientRect deterministic: a 300x100 box at origin, yielding
// exact left / centre / right thirds at 0..100 / 100..200 / 200..300.
const rectMock = {
  left: 0,
  top: 0,
  width: 300,
  height: 100,
  right: 300,
  bottom: 100,
  x: 0,
  y: 0,
  toJSON: () => ({}),
} as DOMRect

function setup(opts: { mirror: boolean }) {
  const videoRef = createRef<HTMLVideoElement>()
  const stepBeat = vi.fn()
  const onTogglePlay = vi.fn()
  const onDotClick = vi.fn()
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root: Root = createRoot(container)
  act(() => {
    root.render(
      <VideoPlayer
        src="dummy.mp4"
        mirror={opts.mirror}
        beatMirror={opts.mirror}
        videoRef={videoRef}
        beatIndex={1}
        pulse={false}
        onTogglePlay={onTogglePlay}
        stepBeat={stepBeat}
        total={3}
        onDotClick={onDotClick}
      />,
    )
  })
  const box = container.querySelector('[aria-label^="视频播放区"]') as HTMLDivElement
  const requestFullscreen = vi.fn(() => Promise.resolve())
  Object.defineProperty(box, 'requestFullscreen', {
    configurable: true,
    value: requestFullscreen,
  })
  return {
    container,
    root,
    box,
    stepBeat,
    onTogglePlay,
    onDotClick,
    requestFullscreen,
  }
}

function click(el: HTMLElement, clientX = 150) {
  act(() => {
    el.dispatchEvent(
      new MouseEvent('click', {
        bubbles: true,
        cancelable: true,
        clientX,
        detail: 1,
      }),
    )
  })
}

// Reproduce the browser event order, including the two clicks that precede a
// dblclick. This verifies that the delayed single-click action is cancelled.
function dblClick(el: HTMLElement, clientX: number) {
  act(() => {
    el.dispatchEvent(
      new MouseEvent('click', {
        bubbles: true,
        cancelable: true,
        clientX,
        detail: 1,
      }),
    )
    el.dispatchEvent(
      new MouseEvent('click', {
        bubbles: true,
        cancelable: true,
        clientX,
        detail: 2,
      }),
    )
    el.dispatchEvent(
      new MouseEvent('dblclick', {
        bubbles: true,
        cancelable: true,
        clientX,
        detail: 2,
      }),
    )
  })
}

function keyDown(el: HTMLElement, key: string) {
  act(() => {
    el.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, cancelable: true, key }))
  })
}

describe('VideoPlayer general playback gestures', () => {
  let rectSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    vi.useFakeTimers()
    rectSpy = vi
      .spyOn(HTMLElement.prototype, 'getBoundingClientRect')
      .mockReturnValue(rectMock)
  })

  afterEach(() => {
    rectSpy.mockRestore()
    vi.useRealTimers()
    document.body.innerHTML = ''
  })

  it('single click toggles playback once after the double-click window', () => {
    const { box, onTogglePlay } = setup({ mirror: false })
    click(box)
    expect(onTogglePlay).not.toHaveBeenCalled()
    act(() => vi.advanceTimersByTime(219))
    expect(onTogglePlay).not.toHaveBeenCalled()
    act(() => vi.advanceTimersByTime(1))
    expect(onTogglePlay).toHaveBeenCalledTimes(1)
  })

  it('left third double-click -> previous beat without toggling playback', () => {
    const { box, stepBeat, onTogglePlay } = setup({ mirror: false })
    dblClick(box, 50)
    act(() => vi.advanceTimersByTime(300))
    expect(stepBeat).toHaveBeenCalledWith(-1)
    expect(onTogglePlay).not.toHaveBeenCalled()
  })

  it('centre third double-click -> fullscreen without stepping or toggling playback', () => {
    const { box, stepBeat, onTogglePlay, requestFullscreen } = setup({ mirror: false })
    dblClick(box, 150)
    act(() => vi.advanceTimersByTime(300))
    expect(requestFullscreen).toHaveBeenCalledTimes(1)
    expect(stepBeat).not.toHaveBeenCalled()
    expect(onTogglePlay).not.toHaveBeenCalled()
  })

  it('right third double-click -> next beat without toggling playback', () => {
    const { box, stepBeat, onTogglePlay } = setup({ mirror: false })
    dblClick(box, 250)
    act(() => vi.advanceTimersByTime(300))
    expect(stepBeat).toHaveBeenCalledWith(1)
    expect(onTogglePlay).not.toHaveBeenCalled()
  })

  it('mirror does not change the physical left/centre/right mapping', () => {
    const { box, stepBeat, requestFullscreen } = setup({ mirror: true })
    dblClick(box, 50)
    dblClick(box, 150)
    dblClick(box, 250)
    expect(stepBeat.mock.calls).toEqual([[-1], [1]])
    expect(requestFullscreen).toHaveBeenCalledTimes(1)
  })

  it('fullscreen button and beat dots do not bubble into playback gestures', () => {
    const {
      container,
      stepBeat,
      onTogglePlay,
      onDotClick,
      requestFullscreen,
    } = setup({ mirror: false })
    const fullscreenButton = container.querySelector('[aria-label="全屏"]') as HTMLElement
    const dot = container.querySelector('.rounded-full') as HTMLElement
    click(fullscreenButton)
    dblClick(dot, 50)
    act(() => vi.advanceTimersByTime(300))
    expect(requestFullscreen).toHaveBeenCalledTimes(1)
    expect(onDotClick).toHaveBeenCalledTimes(2)
    expect(stepBeat).not.toHaveBeenCalled()
    expect(onTogglePlay).not.toHaveBeenCalled()
  })

  it('supports Space/K, arrows and F while the player itself is focused', () => {
    const { box, stepBeat, onTogglePlay, requestFullscreen } = setup({ mirror: false })
    keyDown(box, ' ')
    keyDown(box, 'k')
    keyDown(box, 'ArrowLeft')
    keyDown(box, 'ArrowRight')
    keyDown(box, 'f')
    expect(onTogglePlay).toHaveBeenCalledTimes(2)
    expect(stepBeat.mock.calls).toEqual([[-1], [1]])
    expect(requestFullscreen).toHaveBeenCalledTimes(1)
  })
})
