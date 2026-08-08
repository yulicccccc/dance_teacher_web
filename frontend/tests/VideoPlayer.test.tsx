// Tests for VideoPlayer double-click gesture (Part 2): the play area is split
// into LEFT/RIGHT halves by its bounding rect; right = next beat, left =
// previous beat, independent of video mirror view.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createRef, type RefObject } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react'
import VideoPlayer from '../src/components/VideoPlayer'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

// Make getBoundingClientRect deterministic: a 200x100 box at origin.
const rectMock = {
  left: 0,
  top: 0,
  width: 200,
  height: 100,
  right: 200,
  bottom: 100,
  x: 0,
  y: 0,
  toJSON: () => ({}),
} as DOMRect

function setup(opts: { mirror: boolean }) {
  const videoRef = createRef<HTMLVideoElement>()
  const stepBeat = vi.fn()
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
        stepBeat={stepBeat}
      />,
    )
  })
  // The outer Box (double-click target) is the first child div.
  const box = container.querySelector('div') as HTMLDivElement
  return { container, root, box, stepBeat }
}

function dblClick(el: HTMLElement, clientX: number) {
  act(() => {
    el.dispatchEvent(
      new MouseEvent('dblclick', { bubbles: true, cancelable: true, clientX }),
    )
  })
}

describe('VideoPlayer double-click split-screen', () => {
  let spy: ReturnType<typeof vi.spyOn>
  beforeEach(() => {
    spy = vi
      .spyOn(HTMLElement.prototype, 'getBoundingClientRect')
      .mockReturnValue(rectMock)
  })
  afterEach(() => {
    spy.mockRestore()
    document.body.innerHTML = ''
  })

  it('right half -> next beat (stepBeat(+1)) when not mirrored', () => {
    const { box, stepBeat } = setup({ mirror: false })
    dblClick(box, 150) // 150 > 100 -> right half
    expect(stepBeat).toHaveBeenCalledTimes(1)
    expect(stepBeat).toHaveBeenCalledWith(1)
  })

  it('left half -> previous beat (stepBeat(-1)) when not mirrored', () => {
    const { box, stepBeat } = setup({ mirror: false })
    dblClick(box, 50) // 50 <= 100 -> left half
    expect(stepBeat).toHaveBeenCalledTimes(1)
    expect(stepBeat).toHaveBeenCalledWith(-1)
  })

  it('mirror does not change mapping: right half -> next beat', () => {
    const { box, stepBeat } = setup({ mirror: true })
    dblClick(box, 150)
    expect(stepBeat).toHaveBeenCalledTimes(1)
    expect(stepBeat).toHaveBeenCalledWith(1)
  })

  it('mirror does not change mapping: left half -> previous beat', () => {
    const { box, stepBeat } = setup({ mirror: true })
    dblClick(box, 50)
    expect(stepBeat).toHaveBeenCalledTimes(1)
    expect(stepBeat).toHaveBeenCalledWith(-1)
  })
})
