import { afterEach, describe, expect, it, vi } from 'vitest'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import SegmentList from '../src/components/SegmentList'
import type { Segment } from '../src/types/api'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const segments: Segment[] = [1, 2, 3].map((index) => ({
  index,
  startTime: (index - 1) * 4,
  endTime: index * 4,
  type: 'dance',
  beats: [],
}))

function setup(multiSelect: boolean, showLoopBounds = false) {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  const onSelect = vi.fn()
  const onToggleLoopId = vi.fn()
  const onSelectAll = vi.fn()
  const onClearSelection = vi.fn()
  act(() => {
    root.render(
      <SegmentList
        segments={segments}
        currentSegment={2}
        learnedSegments={[3]}
        onSelect={onSelect}
        multiSelect={multiSelect}
        selectedLoopIds={[1, 3]}
        onToggleLoopId={onToggleLoopId}
        onSelectAll={onSelectAll}
        onClearSelection={onClearSelection}
        showLoopBounds={showLoopBounds}
        beatDuration={0.5}
      />,
    )
  })
  return { container, onSelect, onToggleLoopId, onSelectAll, onClearSelection }
}

describe('SegmentList multi-loop ownership', () => {
  afterEach(() => {
    document.body.innerHTML = ''
  })

  it('renders checkboxes and select-all/clear only in multi mode', () => {
    expect(setup(false).container.querySelectorAll('input[type="checkbox"]')).toHaveLength(0)
    document.body.innerHTML = ''
    const { container } = setup(true)
    expect(container.querySelectorAll('input[type="checkbox"]')).toHaveLength(3)
    expect(container.textContent).toContain('全选')
    expect(container.textContent).toContain('清空')
  })

  it('checkbox selection does not navigate the playhead', () => {
    const { container, onSelect, onToggleLoopId } = setup(true)
    const boxes = container.querySelectorAll('input[type="checkbox"]')
    act(() => (boxes[1] as HTMLInputElement).click())
    expect(onToggleLoopId).toHaveBeenCalledWith(2)
    expect(onSelect).not.toHaveBeenCalled()
  })

  it('shows the exact padded second range only in single-loop view', () => {
    const { container } = setup(false, true)
    expect(container.textContent).toContain('循环 3.50–8.50 秒')
    document.body.innerHTML = ''
    expect(setup(true, false).container.textContent).not.toContain('循环')
  })

  it('labels a retained leading fragment with its real beat numbers', () => {
    const container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)
    act(() => {
      root.render(
        <SegmentList
          segments={[{
            index: 1,
            startTime: 0,
            endTime: 2,
            type: 'dance',
            beats: [0, 0.5, 1, 1.5],
            startBeat: 5,
          }]}
          currentSegment={1}
          learnedSegments={[]}
          onSelect={vi.fn()}
        />,
      )
    })
    expect(container.textContent).toContain('残缺小节 · 5–8 拍')
  })
})
