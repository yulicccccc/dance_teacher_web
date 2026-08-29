import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useAnalysisPolling } from '../src/hooks/useAnalysisPolling'
import type { TaskStatus } from '../src/types/api'

const { getStatusMock, retryMock } = vi.hoisted(() => ({
  getStatusMock: vi.fn(),
  retryMock: vi.fn(),
}))

vi.mock('../src/api/client', () => ({
  apiClient: {
    getStatus: getStatusMock,
    retry: retryMock,
  },
  extractApiError: (error: { message?: string }) => ({
    code: 'TEST',
    message: error.message ?? '测试错误',
    data: null,
  }),
}))

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

function task(status: TaskStatus['status'], progress: number): TaskStatus {
  return { taskId: 'task-1', status, progress, error: null, result: null }
}

function Harness() {
  const state = useAnalysisPolling('task-1')
  return (
    <span
      data-status={state.status?.status ?? ''}
      data-error={state.error ?? ''}
      data-notice={state.notice ?? ''}
      data-loading={String(state.loading)}
    />
  )
}

function mount() {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root: Root = createRoot(container)
  act(() => root.render(<Harness />))
  return { container, root }
}

async function flushPromises() {
  await act(async () => {
    await Promise.resolve()
  })
}

beforeEach(() => {
  vi.useFakeTimers()
  getStatusMock.mockReset()
  retryMock.mockReset()
})

afterEach(() => {
  vi.useRealTimers()
  document.body.innerHTML = ''
})

describe('useAnalysisPolling online backpressure', () => {
  it('never starts another status request while the previous request is pending', async () => {
    let resolveFirst!: (value: TaskStatus) => void
    getStatusMock
      .mockImplementationOnce(
        () => new Promise<TaskStatus>((resolve) => (resolveFirst = resolve)),
      )
      .mockResolvedValue(task('beat_detecting', 50))
    const { root } = mount()

    expect(getStatusMock).toHaveBeenCalledTimes(1)
    await act(async () => vi.advanceTimersByTimeAsync(20000))
    expect(getStatusMock).toHaveBeenCalledTimes(1)

    resolveFirst(task('beat_detecting', 50))
    await flushPromises()
    await act(async () => vi.advanceTimersByTimeAsync(1999))
    expect(getStatusMock).toHaveBeenCalledTimes(1)
    await act(async () => vi.advanceTimersByTimeAsync(1))
    expect(getStatusMock).toHaveBeenCalledTimes(2)
    act(() => root.unmount())
  })

  it('backs off after 429 without showing the raw request error', async () => {
    getStatusMock
      .mockRejectedValueOnce({ response: { status: 429 }, message: 'Request failed with status code 429' })
      .mockResolvedValueOnce(task('beat_detecting', 50))
    const { container, root } = mount()
    await flushPromises()

    const state = container.querySelector('span') as HTMLElement
    expect(state.dataset.error).toBe('')
    expect(state.dataset.notice).toContain('自动等待')
    await act(async () => vi.advanceTimersByTimeAsync(14999))
    expect(getStatusMock).toHaveBeenCalledTimes(1)
    await act(async () => vi.advanceTimersByTimeAsync(1))
    expect(getStatusMock).toHaveBeenCalledTimes(2)
    await flushPromises()
    expect(state.dataset.notice).toBe('')
    act(() => root.unmount())
  })

  it('stops polling after analysis is done', async () => {
    getStatusMock.mockResolvedValue(task('done', 100))
    const { container, root } = mount()
    await flushPromises()
    await act(async () => vi.advanceTimersByTimeAsync(60000))

    expect(getStatusMock).toHaveBeenCalledTimes(1)
    const state = container.querySelector('span') as HTMLElement
    expect(state.dataset.status).toBe('done')
    expect(state.dataset.loading).toBe('false')
    act(() => root.unmount())
  })
})
