// Lightweight regression test for the mirror split (PRD follow-up): the single
// "镜像" toggle is now TWO independent toggles — "视频镜像" (video frame) and
// "拍子镜像" (beat overlay count/dots). Both default on; each flips only its own
// store flag and leaves the other untouched.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createRef, type RefObject } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react'
import ControlBar from '../src/components/ControlBar'
import { useLessonStore } from '../src/store/lessonStore'
import type { Segment } from '../src/types/api'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

function noop() {
  return vi.fn()
}

function setup() {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root: Root = createRoot(container)
  act(() => {
    root.render(
      <ControlBar
        playing={false}
        canPrev={false}
        canNext={false}
        onTogglePlay={noop()}
        onPrev={noop()}
        onNext={noop()}
        onMarkLearned={noop()}
        learned={false}
        segments={[] as Segment[]}
        abLoop={null}
        onSetA={noop()}
        onSetB={noop()}
        onEnableAB={noop()}
        onDisableAB={noop()}
        onClearAB={noop()}
        onCompare={noop()}
        comparing={false}
      />,
    )
  })
  return { container, root }
}

function buttonByText(container: HTMLElement, text: string): HTMLButtonElement {
  const btns = Array.from(container.querySelectorAll('button')) as HTMLButtonElement[]
  const found = btns.find((b) => b.textContent?.includes(text))
  if (!found) throw new Error(`button containing "${text}" not found`)
  return found
}

describe('ControlBar mirror split', () => {
  beforeEach(() => {
    useLessonStore.getState().reset()
    // sanity: both mirrors default on
    expect(useLessonStore.getState().mirror).toBe(true)
    expect(useLessonStore.getState().beatMirror).toBe(true)
  })
  afterEach(() => {
    document.body.innerHTML = ''
  })

  it('renders two separate mirror buttons (视频镜像 / 拍子镜像)', () => {
    const { container } = setup()
    expect(buttonByText(container, '视频镜像')).toBeTruthy()
    expect(buttonByText(container, '拍子镜像')).toBeTruthy()
    // the old single "镜像" button text is gone
    const btns = Array.from(container.querySelectorAll('button'))
    expect(btns.some((b) => b.textContent?.trim() === '镜像')).toBe(false)
  })

  it('toggling 视频镜像 flips only mirror, leaving beatMirror untouched', () => {
    const { container } = setup()
    act(() => {
      buttonByText(container, '视频镜像').click()
    })
    expect(useLessonStore.getState().mirror).toBe(false)
    expect(useLessonStore.getState().beatMirror).toBe(true)
  })

  it('toggling 拍子镜像 flips only beatMirror, leaving mirror untouched', () => {
    const { container } = setup()
    act(() => {
      buttonByText(container, '拍子镜像').click()
    })
    expect(useLessonStore.getState().beatMirror).toBe(false)
    expect(useLessonStore.getState().mirror).toBe(true)
  })
})
