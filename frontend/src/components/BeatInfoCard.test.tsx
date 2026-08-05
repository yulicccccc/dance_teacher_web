// Tests for the BeatInfoCard component's BPM validation and recompute button.
// Follows the repo's existing convention (react-dom createRoot + act, no
// @testing-library) established in tests/uploader.test.tsx.
import { describe, it, expect, vi, afterEach } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react'
import BeatInfoCard from './BeatInfoCard'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const ERROR_TEXT = 'BPM 需在 40–300 之间'

function renderCard(opts: {
  bpm?: number
  confidence?: number
  loading?: boolean
  onApplyBpm?: (bpm: number) => void
}) {
  const onApplyBpm = opts.onApplyBpm ?? vi.fn()
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root: Root = createRoot(container)
  act(() => {
    root.render(
      <BeatInfoCard
        bpm={opts.bpm ?? 120}
        confidence={opts.confidence ?? 0.9}
        loading={opts.loading ?? false}
        onApplyBpm={onApplyBpm}
      />,
    )
  })
  return { container, root, onApplyBpm }
}

function setInputValue(input: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(
    window.HTMLInputElement.prototype,
    'value',
  )!.set!
  act(() => {
    setter.call(input, value)
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

describe('BeatInfoCard', () => {
  afterEach(() => {
    document.body.innerHTML = ''
  })

  it('disables the button and shows the error for an empty value', () => {
    const { container, onApplyBpm } = renderCard({})
    const input = container.querySelector('input[type="number"]') as HTMLInputElement
    setInputValue(input, '')
    const btn = container.querySelector('button') as HTMLButtonElement
    expect(btn.disabled).toBe(true)
    expect(container.textContent).toContain(ERROR_TEXT)
    expect(onApplyBpm).not.toHaveBeenCalled()
  })

  it('disables the button for a non-numeric value', () => {
    const { container, onApplyBpm } = renderCard({})
    const input = container.querySelector('input[type="number"]') as HTMLInputElement
    setInputValue(input, 'abc')
    const btn = container.querySelector('button') as HTMLButtonElement
    expect(btn.disabled).toBe(true)
    expect(container.textContent).toContain(ERROR_TEXT)
    expect(onApplyBpm).not.toHaveBeenCalled()
  })

  it('disables the button for a value below the minimum (39)', () => {
    const { container, onApplyBpm } = renderCard({})
    const input = container.querySelector('input[type="number"]') as HTMLInputElement
    setInputValue(input, '39')
    const btn = container.querySelector('button') as HTMLButtonElement
    expect(btn.disabled).toBe(true)
    expect(container.textContent).toContain(ERROR_TEXT)
    expect(onApplyBpm).not.toHaveBeenCalled()
  })

  it('disables the button for a value above the maximum (301)', () => {
    const { container, onApplyBpm } = renderCard({})
    const input = container.querySelector('input[type="number"]') as HTMLInputElement
    setInputValue(input, '301')
    const btn = container.querySelector('button') as HTMLButtonElement
    expect(btn.disabled).toBe(true)
    expect(container.textContent).toContain(ERROR_TEXT)
    expect(onApplyBpm).not.toHaveBeenCalled()
  })

  it('enables the button for a valid value and calls onApplyBpm with the number', () => {
    const { container, onApplyBpm } = renderCard({ bpm: 120 })
    const input = container.querySelector('input[type="number"]') as HTMLInputElement
    setInputValue(input, '140')
    const btn = container.querySelector('button') as HTMLButtonElement
    expect(btn.disabled).toBe(false)
    act(() => {
      btn.click()
    })
    expect(onApplyBpm).toHaveBeenCalledTimes(1)
    expect(onApplyBpm).toHaveBeenCalledWith(140)
  })

  it('disables the button while loading', () => {
    const { container } = renderCard({ loading: true })
    const btn = container.querySelector('button') as HTMLButtonElement
    expect(btn.disabled).toBe(true)
  })
})
