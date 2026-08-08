// Regression tests for the Uploader component's cold-start timeout UX:
//  - both upload branches POST with timeout 300000
//  - a timeout/network error shows a friendly retry message and KEEPS the file
//  - a normal backend error shows the backend's Chinese message (no friendly copy)
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react'
import Uploader from '../src/components/Uploader'

const { postMock } = vi.hoisted(() => {
  const postMock = vi.fn()
  return { postMock }
})

vi.mock('axios', () => ({
  default: {
    create: () => ({
      post: postMock,
      get: vi.fn(),
    }),
  },
}))

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const FRIENDLY =
  '服务器正在启动或网络较慢，文件已保留，请稍候点击【开始分析】再试一次'

function renderUploader(
  onError: (m: string) => void,
  onUploaded: (t: string, v: string) => void = () => {},
) {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root: Root = createRoot(container)
  act(() => {
    root.render(<Uploader onUploaded={onUploaded} onError={onError} />)
  })
  return { container, root }
}

function selectFile(container: HTMLElement, name = 'dance.mp4'): File {
  const input = container.querySelector('input[type="file"]') as HTMLInputElement
  const file = new File(['x'], name, { type: 'video/mp4' })
  const files = {
    0: file,
    length: 1,
    item: (i: number) => (i === 0 ? file : null),
  }
  Object.defineProperty(input, 'files', { value: files, configurable: true })
  act(() => {
    input.dispatchEvent(new Event('change', { bubbles: true }))
  })
  return file
}

describe('Uploader — cold-start timeout UX', () => {
  beforeEach(() => {
    postMock.mockReset()
  })
  afterEach(() => {
    document.body.innerHTML = ''
  })

  it('file branch POST uses a 300000ms timeout', async () => {
    postMock.mockResolvedValue({ data: { taskId: 't', status: 'queued' } })
    const onError = vi.fn()
    const { container } = renderUploader(onError)
    selectFile(container)
    const btn = container.querySelector('button') as HTMLButtonElement
    await act(async () => {
      btn.click()
    })
    expect(postMock).toHaveBeenCalledTimes(1)
    const [, , config] = postMock.mock.calls[0]
    expect(config.timeout).toBe(300000)
  })

  it('url branch POST uses a 300000ms timeout', async () => {
    postMock.mockResolvedValue({ data: { taskId: 't', status: 'queued' } })
    const onError = vi.fn()
    const { container } = renderUploader(onError)
    const urlInput = container.querySelector(
      'input[placeholder="或粘贴视频链接（可选）"]',
    ) as HTMLInputElement
    const setter = Object.getOwnPropertyDescriptor(
      window.HTMLInputElement.prototype,
      'value',
    )!.set!
    act(() => {
      setter.call(urlInput, 'https://example.com/v.mp4')
      urlInput.dispatchEvent(new Event('input', { bubbles: true }))
    })
    const btn = container.querySelector('button') as HTMLButtonElement
    await act(async () => {
      btn.click()
    })
    expect(postMock).toHaveBeenCalledTimes(1)
    const [, body, config] = postMock.mock.calls[0]
    expect(body).toEqual({ url: 'https://example.com/v.mp4' })
    expect(config.timeout).toBe(300000)
  })

  it('shows friendly retry message and keeps the file on ECONNABORTED timeout', async () => {
    const err: { code: string; message: string } = Object.assign(
      new Error('timeout of 300000ms exceeded'),
      { code: 'ECONNABORTED' },
    )
    postMock.mockRejectedValue(err)
    const onError = vi.fn()
    const onUploaded = vi.fn()
    const { container } = renderUploader(onError, onUploaded)
    const file = selectFile(container)
    const btn = container.querySelector('button') as HTMLButtonElement
    expect(btn.disabled).toBe(false)

    // First attempt fails with a timeout.
    await act(async () => {
      btn.click()
    })
    expect(onError).toHaveBeenCalledWith(FRIENDLY)
    expect(onUploaded).not.toHaveBeenCalled()

    // File retained: name still shown and the button is still clickable.
    expect(container.textContent).toContain(file.name)
    expect(btn.disabled).toBe(false)

    // Retry without re-picking the file.
    await act(async () => {
      btn.click()
    })
    expect(postMock).toHaveBeenCalledTimes(2)
    expect(onError).toHaveBeenLastCalledWith(FRIENDLY)
  })

  it('shows backend Chinese message on a normal 400 error (no friendly copy)', async () => {
    const err: {
      message: string
      response: { data: { message: string } }
    } = Object.assign(new Error('Request failed with status code 400'), {
      response: { data: { message: '该视频格式不支持，请上传 mp4' } },
    })
    postMock.mockRejectedValue(err)
    const onError = vi.fn()
    const { container } = renderUploader(onError)
    selectFile(container)
    const btn = container.querySelector('button') as HTMLButtonElement
    await act(async () => {
      btn.click()
    })
    expect(onError).toHaveBeenCalledWith('该视频格式不支持，请上传 mp4')
    expect(onError).not.toHaveBeenCalledWith(FRIENDLY)
  })
})
