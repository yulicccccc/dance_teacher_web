import { afterEach, describe, expect, it, vi } from 'vitest'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import BeatInfoCard, { estimateTappedBpm } from '../src/components/BeatInfoCard'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

describe('BeatInfoCard tap tempo', () => {
  afterEach(() => {
    vi.restoreAllMocks()
    document.body.innerHTML = ''
  })

  it('uses the median tap interval so one uneven tap does not dominate', () => {
    expect(estimateTappedBpm([0, 500, 1000, 1530, 2030])).toBe(120)
    expect(estimateTappedBpm([0])).toBeNull()
  })

  it('fills the editable BPM after four taps and reuses the existing apply path', () => {
    let tapNow = 0
    vi.spyOn(performance, 'now').mockImplementation(() => tapNow)
    const onApplyBpm = vi.fn()
    const container = document.createElement('div')
    document.body.appendChild(container)
    act(() => {
      createRoot(container).render(
        <BeatInfoCard bpm={126} confidence={0.5} onApplyBpm={onApplyBpm} />,
      )
    })

    for (let i = 0; i < 4; i += 1) {
      const tapButton = Array.from(container.querySelectorAll('button')).find((item) =>
        item.textContent?.includes('跟拍点按'),
      ) as HTMLButtonElement
      act(() => tapButton.click())
      tapNow += 500
    }

    const bpmInput = container.querySelector('input[type="number"]') as HTMLInputElement
    expect(bpmInput.value).toBe('120.0')
    const applyButton = Array.from(container.querySelectorAll('button')).find(
      (item) => item.textContent?.trim() === '用此 BPM 重算',
    ) as HTMLButtonElement
    act(() => applyButton.click())
    expect(onApplyBpm).toHaveBeenCalledWith(120)
  })
})
