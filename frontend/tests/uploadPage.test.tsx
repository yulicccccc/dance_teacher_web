// Regression test for UploadPage's "warming" indicator driven by apiClient.warmup().
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createRoot } from 'react-dom/client'
import { act } from 'react'
import { MemoryRouter } from 'react-router-dom'
import UploadPage from '../src/pages/UploadPage'
import { apiClient } from '../src/api/client'

// Replace only apiClient.warmup with a controllable spy; keep the rest real.
vi.mock('../src/api/client', async (importOriginal) => {
  const actual = (await importOriginal()) as {
    apiClient: { warmup: () => Promise<void> } & Record<string, unknown>
  }
  return {
    ...actual,
    apiClient: {
      ...actual.apiClient,
      warmup: vi.fn().mockResolvedValue(undefined),
    },
  }
})

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

describe('UploadPage — server warm-up indicator', () => {
  beforeEach(() => {
    ;(apiClient.warmup as unknown as ReturnType<typeof vi.fn>).mockClear()
  })
  afterEach(() => {
    document.body.innerHTML = ''
  })

  it('calls warmup, shows "正在唤醒服务器…" while warming, then hides it after warmup resolves', async () => {
    const container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)

    act(() => {
      root.render(
        <MemoryRouter>
          <UploadPage />
        </MemoryRouter>,
      )
    })
    // useEffect fired the fire-and-forget warm-up.
    expect(apiClient.warmup).toHaveBeenCalledTimes(1)
    // Indicator visible during warm-up.
    expect(container.textContent).toContain('正在唤醒服务器…')

    // Let the (mock) warm-up promise resolve so .finally hides the indicator.
    await act(async () => {
      await Promise.resolve()
    })
    expect(container.textContent).not.toContain('正在唤醒服务器…')
    expect(container.textContent).toContain('试用示例（无需上传）')

    root.unmount()
    container.remove()
  })
})
