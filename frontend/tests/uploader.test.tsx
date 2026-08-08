// Uploader (zero-server build): selecting a valid video and clicking 开始分析
// invokes onStart with that File; a non-video file is rejected via onError and
// never reaches onStart. No axios / network is involved.
import { describe, it, expect, vi, afterEach } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react'
import Uploader from '../src/components/Uploader'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

function renderUploader(onStart: (f: File) => void, onError = vi.fn()) {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root: Root = createRoot(container)
  act(() => {
    root.render(<Uploader onStart={onStart} onError={onError} />)
  })
  return { container, root }
}

function selectFile(container: HTMLElement, file: File): void {
  const input = container.querySelector('input[type="file"]') as HTMLInputElement
  const files = { 0: file, length: 1, item: (i: number) => (i === 0 ? file : null) }
  Object.defineProperty(input, 'files', { value: files, configurable: true })
  act(() => {
    input.dispatchEvent(new Event('change', { bubbles: true }))
  })
}

describe('Uploader — local-first start', () => {
  afterEach(() => {
    document.body.innerHTML = ''
  })

  it('calls onStart with the selected video file when 开始分析 is clicked', async () => {
    const onStart = vi.fn()
    const onError = vi.fn()
    const { container } = renderUploader(onStart, onError)
    const file = new File(['x'], 'dance.mp4', { type: 'video/mp4' })
    selectFile(container, file)
    const btn = container.querySelector('button') as HTMLButtonElement
    await act(async () => {
      btn.click()
    })
    expect(onStart).toHaveBeenCalledTimes(1)
    expect(onStart).toHaveBeenCalledWith(file)
    expect(onError).not.toHaveBeenCalled()
  })

  it('rejects a non-video file via onError and does not call onStart', async () => {
    const onStart = vi.fn()
    const onError = vi.fn()
    const { container } = renderUploader(onStart, onError)
    const file = new File(['x'], 'note.txt', { type: 'text/plain' })
    selectFile(container, file)
    const btn = container.querySelector('button') as HTMLButtonElement
    await act(async () => {
      btn.click()
    })
    expect(onError).toHaveBeenCalled()
    expect(onStart).not.toHaveBeenCalled()
  })
})
