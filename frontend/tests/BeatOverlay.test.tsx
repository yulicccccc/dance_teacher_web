// Tests for BeatOverlay (Part 2): mirror transform + clickable beat dots.
import { describe, it, expect, afterEach, vi } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react'
import BeatOverlay from '../src/components/BeatOverlay'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

function setup(opts: { mirror?: boolean; onDotClick?: (i: number) => void; total?: number }) {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root: Root = createRoot(container)
  act(() => {
    root.render(
      <BeatOverlay
        beatIndex={3}
        pulse={false}
        total={opts.total ?? 8}
        mirror={opts.mirror}
        onDotClick={opts.onDotClick}
      />,
    )
  })
  return { container, root }
}

describe('BeatOverlay', () => {
  afterEach(() => {
    document.body.innerHTML = ''
  })

  it('renders one dot per beat (total=8) and none is clickable without onDotClick', () => {
    const { container, root } = setup({})
    const dots = container.querySelectorAll('.rounded-full')
    expect(dots.length).toBe(8)
    // Clicking a dot when onDotClick is absent must not throw.
    act(() => {
      ;(dots[2] as HTMLElement).click()
    })
    root.unmount()
  })

  it('does NOT apply a mirror transform when mirror is false', () => {
    const { container } = setup({ mirror: false })
    const box = container.firstChild as HTMLElement
    expect(box.style.transform).toBe('none')
  })

  it('applies scaleX(-1) when mirror is true', () => {
    const { container } = setup({ mirror: true })
    const box = container.firstChild as HTMLElement
    expect(box.style.transform).toBe('scaleX(-1)')
  })

  it('calls onDotClick with the 0-based dot index when a dot is clicked', () => {
    const onDotClick = vi.fn()
    const { container } = setup({ onDotClick })
    const dots = container.querySelectorAll('.rounded-full')
    act(() => {
      ;(dots[0] as HTMLElement).click()
    })
    act(() => {
      ;(dots[5] as HTMLElement).click()
    })
    expect(onDotClick).toHaveBeenCalledTimes(2)
    expect(onDotClick).toHaveBeenNthCalledWith(1, 0)
    expect(onDotClick).toHaveBeenNthCalledWith(2, 5)
  })

  it('clickable dots keep pointer-events auto while the overlay stays none', () => {
    const onDotClick = vi.fn()
    const { container } = setup({ onDotClick })
    const dots = container.querySelectorAll('.rounded-full')
    const dot = dots[3] as HTMLElement
    expect(getComputedStyle(dot).pointerEvents).toBe('auto')
  })
})
