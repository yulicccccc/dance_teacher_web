// Tests for the LoopPanel (Part 2): single/multi radio + segment checklist.
// Follows the repo convention (react-dom createRoot + act, no @testing-library).
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createRef, type RefObject } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react'
import LoopPanel from '../src/components/LoopPanel'
import { useLessonStore } from '../src/store/lessonStore'
import type { Segment } from '../src/types/api'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

// 3 contiguous 8-beat segments @ 120 BPM (0.5s/beat), 4s each.
function makeSegments(): Segment[] {
  return Array.from({ length: 3 }, (_, i) => {
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

function setup(segments: Segment[]) {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root: Root = createRoot(container)
  act(() => {
    root.render(<LoopPanel segments={segments} />)
  })
  return { container, root }
}

describe('LoopPanel', () => {
  beforeEach(() => {
    // Start from a clean store so each test sees the default `single` mode.
    useLessonStore.getState().reset()
  })
  afterEach(() => {
    document.body.innerHTML = ''
  })

  it('defaults to single mode (radio "single" checked)', () => {
    const { container } = setup(makeSegments())
    const radios = Array.from(
      container.querySelectorAll('input[type="radio"]'),
    ) as HTMLInputElement[]
    const single = radios.find((r) => r.value === 'single')!
    const multi = radios.find((r) => r.value === 'multi')!
    expect(single.checked).toBe(true)
    expect(multi.checked).toBe(false)
    // No checklist shown until multi is selected.
    expect(container.textContent).not.toContain('第 1 节')
  })

  it('switching to multi reveals the segment checklist', () => {
    const { container } = setup(makeSegments())
    expect(useLessonStore.getState().loopMode).toBe('single')
    const multi = Array.from(
      container.querySelectorAll('input[type="radio"]'),
    ).find((r) => (r as HTMLInputElement).value === 'multi') as HTMLInputElement
    act(() => {
      multi.click()
    })
    expect(useLessonStore.getState().loopMode).toBe('multi')
    expect(container.textContent).toContain('第 1 节 (0:00 – 0:04)')
    expect(container.textContent).toContain('第 2 节 (0:04 – 0:08)')
    expect(container.textContent).toContain('第 3 节 (0:08 – 0:12)')
  })

  it('ticking a segment updates loopSegmentIds in the store', () => {
    const { container } = setup(makeSegments())
    const multi = Array.from(
      container.querySelectorAll('input[type="radio"]'),
    ).find((r) => (r as HTMLInputElement).value === 'multi') as HTMLInputElement
    act(() => {
      multi.click()
    })
    const boxes = Array.from(
      container.querySelectorAll('input[type="checkbox"]'),
    ) as HTMLInputElement[]
    act(() => {
      boxes[0].click() // 第 1 节
      boxes[2].click() // 第 3 节
    })
    expect(useLessonStore.getState().loopSegmentIds).toEqual([1, 3])
    act(() => {
      boxes[0].click() // un-tick 第 1 节
    })
    expect(useLessonStore.getState().loopSegmentIds).toEqual([3])
  })

  it('"全选" selects every segment and "清空" clears the selection', () => {
    const { container } = setup(makeSegments())
    const multi = Array.from(
      container.querySelectorAll('input[type="radio"]'),
    ).find((r) => (r as HTMLInputElement).value === 'multi') as HTMLInputElement
    act(() => {
      multi.click()
    })
    const buttons = Array.from(
      container.querySelectorAll('button'),
    ) as HTMLButtonElement[]
    const selectAll = buttons.find((b) => b.textContent === '全选')!
    const clear = buttons.find((b) => b.textContent === '清空')!
    act(() => selectAll.click())
    expect(useLessonStore.getState().loopSegmentIds).toEqual([1, 2, 3])
    act(() => clear.click())
    expect(useLessonStore.getState().loopSegmentIds).toEqual([])
  })
})
