import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import ControlBar from '../src/components/ControlBar'
import { useLessonStore } from '../src/store/lessonStore'
import type { Segment } from '../src/types/api'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const segments: Segment[] = Array.from({ length: 3 }, (_, i) => ({
  index: i + 1,
  startTime: i * 4,
  endTime: i * 4 + 4,
  type: 'dance',
  beats: Array.from({ length: 8 }, (_, beat) => i * 4 + beat * 0.5),
}))

function setup(onConfirmBeatOffset?: (offset: number) => void) {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  const noop = vi.fn()
  act(() => {
    root.render(
      <ControlBar
        playing={false}
        canPrev={false}
        canNext={true}
        currentSegment={1}
        currentTime={1}
        duration={12}
        onSeekTime={noop}
        onTogglePlay={noop}
        onPrev={noop}
        onNext={noop}
        onMarkLearned={noop}
        learned={false}
        segments={segments}
        onSetA={noop}
        onSetB={noop}
        onClearAB={noop}
        onCompare={noop}
        onConfirmBeatOffset={onConfirmBeatOffset}
      />,
    )
  })
  return container
}

function button(container: HTMLElement, exactText: string) {
  return Array.from(container.querySelectorAll('button')).find(
    (item) => item.textContent?.trim() === exactText,
  ) as HTMLButtonElement
}

describe('ControlBar loop-redesign contract', () => {
  beforeEach(() => useLessonStore.getState().reset())
  afterEach(() => {
    document.body.innerHTML = ''
  })

  it('has exactly one fixed-label master loop button', () => {
    const container = setup()
    const loopButtons = Array.from(container.querySelectorAll('button')).filter(
      (item) => item.textContent?.trim() === '循环',
    )
    expect(loopButtons).toHaveLength(1)
    act(() => loopButtons[0].dispatchEvent(new MouseEvent('click', { bubbles: true })))
    expect(useLessonStore.getState().loopEnabled).toBe(true)
    expect(loopButtons[0].textContent?.trim()).toBe('循环')
  })

  it('orders the fine-practice modes before the existing three loop modes', () => {
    const container = setup()
    const labels = Array.from(
      container.querySelectorAll('[aria-label="循环模式"] button'),
    ).map((item) => item.textContent?.trim())
    expect(labels).toEqual(['当前', '前节', '后节', '单节', '多节', 'AB'])
  })

  it('disables multi loop until the left-list selection is non-empty', () => {
    const container = setup()
    act(() => useLessonStore.getState().setLoopMode('multi'))
    expect(button(container, '循环').disabled).toBe(true)
    act(() => useLessonStore.getState().setLoopSegmentIds([1, 2]))
    expect(button(container, '循环').disabled).toBe(false)
    expect(container.textContent).toContain('已选 2 节')
  })

  it('shows AB controls only in AB mode and rejects an invalid range', () => {
    const container = setup()
    expect(container.textContent).not.toContain('设 A')
    act(() => useLessonStore.getState().setLoopMode('ab'))
    expect(container.textContent).toContain('设 A')
    expect(button(container, '循环').disabled).toBe(true)
    act(() =>
      useLessonStore.getState().setABLoop({
        enabled: false,
        aTime: 2,
        bTime: 6,
        aBeat: 5,
        bBeat: 13,
      }),
    )
    expect(button(container, '循环').disabled).toBe(false)
  })

  it('keeps video and beat-overlay mirrors independent', () => {
    const container = setup()
    act(() => button(container, '视频镜像').click())
    expect(useLessonStore.getState().mirror).toBe(false)
    expect(useLessonStore.getState().beatMirror).toBe(true)
    act(() => button(container, '拍点镜像').click())
    expect(useLessonStore.getState().mirror).toBe(false)
    expect(useLessonStore.getState().beatMirror).toBe(false)
  })

  it('keeps beat-offset edits as a draft until explicit confirmation', () => {
    const container = setup()
    act(() => useLessonStore.getState().setDraftBeatOffset(2))
    expect(useLessonStore.getState().beatOffset).toBe(0)
    const confirm = button(container, '重新计算拍子')
    expect(confirm.disabled).toBe(false)
    act(() => confirm.click())
    expect(useLessonStore.getState().beatOffset).toBe(2)
  })

  it('delegates confirmed offset so the lesson can reconcile every dependent feature', () => {
    const onConfirm = vi.fn()
    const container = setup(onConfirm)
    act(() => useLessonStore.getState().setDraftBeatOffset(3))
    act(() => button(container, '重新计算拍子').click())
    expect(onConfirm).toHaveBeenCalledWith(3)
    expect(useLessonStore.getState().beatOffset).toBe(0)
  })
})
