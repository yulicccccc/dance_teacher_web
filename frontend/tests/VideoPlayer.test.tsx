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
  const onPrevSegment = vi.fn()
  const onNextSegment = vi.fn()
  const onAdjustPlaybackRate = vi.fn()
  const onResetPlaybackRate = vi.fn()
  const onToggleLoop = vi.fn()
  const onSelectLoopMode = vi.fn()
  const onSetA = vi.fn()
  const onSetB = vi.fn()
  const onClearAB = vi.fn()
  const onToggleMirror = vi.fn()
  const onToggleBeatMirror = vi.fn()
  const onToggleVoice = vi.fn()
  const onToggleMetronome = vi.fn()
  const onToggleLearned = vi.fn()
  const onShowShortcuts = vi.fn()
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
        onPrevSegment={onPrevSegment}
        onNextSegment={onNextSegment}
        onAdjustPlaybackRate={onAdjustPlaybackRate}
        onResetPlaybackRate={onResetPlaybackRate}
        onToggleLoop={onToggleLoop}
        onSelectLoopMode={onSelectLoopMode}
        onSetA={onSetA}
        onSetB={onSetB}
        onClearAB={onClearAB}
        onToggleMirror={onToggleMirror}
        onToggleBeatMirror={onToggleBeatMirror}
        onToggleVoice={onToggleVoice}
        onToggleMetronome={onToggleMetronome}
        onToggleLearned={onToggleLearned}
        onShowShortcuts={onShowShortcuts}
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
    onPrevSegment,
    onNextSegment,
    onAdjustPlaybackRate,
    onResetPlaybackRate,
    onToggleLoop,
    onSelectLoopMode,
    onSetA,
    onSetB,
    onClearAB,
    onToggleMirror,
    onToggleBeatMirror,
    onToggleVoice,
    onToggleMetronome,
    onToggleLearned,
    onShowShortcuts,
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

function keyDown(
  el: HTMLElement,
  key: string,
  code = '',
  modifiers: Pick<KeyboardEventInit, 'shiftKey' | 'metaKey' | 'ctrlKey' | 'altKey' | 'repeat'> = {},
) {
  act(() => {
    el.dispatchEvent(
      new KeyboardEvent('keydown', {
        bubbles: true,
        cancelable: true,
        key,
        code,
        ...modifiers,
      }),
    )
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

  it('supports Movist-style comma/period for previous/next beat across input methods', () => {
    const { box, stepBeat } = setup({ mirror: false })
    keyDown(box, ',', 'Comma')
    // A Chinese input method may report a full-width punctuation key value;
    // the physical code must keep the shortcut stable.
    keyDown(box, '。', 'Period')
    expect(stepBeat.mock.calls).toEqual([[-1], [1]])

    const input = document.createElement('input')
    box.appendChild(input)
    keyDown(input, ',', 'Comma')
    expect(stepBeat).toHaveBeenCalledTimes(2)
  })

  it('supports section navigation and precise playback-rate shortcuts', () => {
    const {
      box,
      stepBeat,
      onPrevSegment,
      onNextSegment,
      onAdjustPlaybackRate,
      onResetPlaybackRate,
    } = setup({ mirror: false })

    keyDown(box, 'ArrowLeft', 'ArrowLeft', { shiftKey: true })
    keyDown(box, 'ArrowRight', 'ArrowRight', { shiftKey: true })
    keyDown(box, '[', 'BracketLeft')
    keyDown(box, ']', 'BracketRight')
    keyDown(box, '<', 'Comma', { shiftKey: true })
    keyDown(box, '>', 'Period', { shiftKey: true })
    keyDown(box, '-', 'Minus')
    keyDown(box, '+', 'Equal', { shiftKey: true })
    keyDown(box, '0', 'Digit0')

    expect(onPrevSegment).toHaveBeenCalledTimes(2)
    expect(onNextSegment).toHaveBeenCalledTimes(2)
    expect(onAdjustPlaybackRate.mock.calls).toEqual([[-1], [1], [-1], [1]])
    expect(onResetPlaybackRate).toHaveBeenCalledTimes(1)
    expect(stepBeat).not.toHaveBeenCalled()
  })

  it('supports loop, AB, mirror, voice, learned and shortcut-help commands', () => {
    const {
      box,
      onToggleLoop,
      onSelectLoopMode,
      onSetA,
      onSetB,
      onClearAB,
      onToggleMirror,
      onToggleBeatMirror,
      onToggleVoice,
      onToggleMetronome,
      onToggleLearned,
      onShowShortcuts,
    } = setup({ mirror: false })

    keyDown(box, 'r', 'KeyR')
    keyDown(box, 'm', 'KeyM')
    keyDown(box, 'M', 'KeyM', { shiftKey: true })
    keyDown(box, 'c', 'KeyC')
    keyDown(box, 'C', 'KeyC', { shiftKey: true })
    keyDown(box, 'd', 'KeyD')
    ;['Digit1', 'Digit2', 'Digit3', 'Digit4', 'Digit5', 'Digit6'].forEach((code, i) =>
      keyDown(box, String(i + 1), code),
    )
    keyDown(box, 'a', 'KeyA')
    keyDown(box, 'b', 'KeyB')
    keyDown(box, 'x', 'KeyX')
    keyDown(box, '?', 'Slash', { shiftKey: true })

    expect(onToggleLoop).toHaveBeenCalledTimes(1)
    expect(onToggleMirror).toHaveBeenCalledTimes(1)
    expect(onToggleBeatMirror).toHaveBeenCalledTimes(1)
    expect(onToggleVoice).toHaveBeenCalledTimes(1)
    expect(onToggleMetronome).toHaveBeenCalledTimes(1)
    expect(onToggleLearned).toHaveBeenCalledTimes(1)
    expect(onSelectLoopMode.mock.calls).toEqual([
      ['current'],
      ['front'],
      ['back'],
      ['single'],
      ['multi'],
      ['ab'],
    ])
    expect(onSetA).toHaveBeenCalledTimes(1)
    expect(onSetB).toHaveBeenCalledTimes(1)
    expect(onClearAB).toHaveBeenCalledTimes(1)
    expect(onShowShortcuts).toHaveBeenCalledTimes(1)
  })

  it('does not steal browser shortcuts or repeat toggle commands', () => {
    const { box, onToggleLoop, onToggleMirror } = setup({ mirror: false })
    keyDown(box, 'r', 'KeyR', { metaKey: true })
    keyDown(box, 'r', 'KeyR', { ctrlKey: true })
    keyDown(box, 'm', 'KeyM', { repeat: true })
    expect(onToggleLoop).not.toHaveBeenCalled()
    expect(onToggleMirror).not.toHaveBeenCalled()
  })
})
