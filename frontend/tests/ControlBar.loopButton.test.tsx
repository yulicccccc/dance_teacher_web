// Regression test for the loop button label confusion:
// the main loop toggle must reflect the current loopMode (single vs multi)
// and the number of selected segments; in multi mode with no selection it
// should be disabled with a clear tooltip (instead of still reading "单节循环").
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react'
import ControlBar from '../src/components/ControlBar'
import { useLessonStore } from '../src/store/lessonStore'
import type { Segment } from '../src/types/api'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

function noop() {
  return vi.fn()
}

function makeSegments(): Segment[] {
  return Array.from({ length: 4 }, (_, i) => {
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
        segments={makeSegments()}
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

function loopButton(container: HTMLElement): HTMLButtonElement {
  const btns = Array.from(container.querySelectorAll('button')) as HTMLButtonElement[]
  return btns.find((b) => b.textContent?.includes('循环'))!
}

describe('ControlBar loop button label', () => {
  beforeEach(() => {
    useLessonStore.getState().reset()
  })
  afterEach(() => {
    document.body.innerHTML = ''
  })

  it('single mode: reads "单节循环"', () => {
    const { container } = setup()
    expect(useLessonStore.getState().loopMode).toBe('single')
    expect(loopButton(container).textContent).toContain('单节循环')
    expect(loopButton(container).disabled).toBe(false)
  })

  it('multi mode with selected segments: reads "多选循环 (N)"', () => {
    const { container } = setup()
    act(() => {
      useLessonStore.setState({ loopMode: 'multi', loopSegmentIds: [2, 3, 4] })
    })
    expect(loopButton(container).textContent).toContain('多选循环 (3)')
    expect(loopButton(container).disabled).toBe(false)
  })

  it('multi mode without selected segments: reads "多选循环" and is disabled', () => {
    const { container } = setup()
    act(() => {
      useLessonStore.setState({ loopMode: 'multi', loopSegmentIds: [] })
    })
    expect(loopButton(container).textContent).toContain('多选循环')
    expect(loopButton(container).textContent).not.toContain('单节循环')
    expect(loopButton(container).disabled).toBe(true)
  })

  it('clicking the button toggles loopSegment in single mode', () => {
    const { container } = setup()
    act(() => {
      loopButton(container).click()
    })
    expect(useLessonStore.getState().loopSegment).toBe(true)
    act(() => {
      loopButton(container).click()
    })
    expect(useLessonStore.getState().loopSegment).toBe(false)
  })
})
