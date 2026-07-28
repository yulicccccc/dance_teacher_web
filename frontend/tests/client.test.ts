// Regression tests for the Render cold-start (upload timeout) fix.
// Covers apiClient.warmup() and apiClient.upload() extended timeout.
import { describe, it, expect, vi, beforeEach } from 'vitest'

// Mock axios so `http = axios.create(...)` returns an instance whose
// post/get we fully control and can inspect (config.timeout, call counts).
const { postMock, getMock } = vi.hoisted(() => {
  const postMock = vi.fn()
  const getMock = vi.fn()
  return { postMock, getMock }
})

vi.mock('axios', () => ({
  default: {
    create: () => ({
      post: postMock,
      get: getMock,
    }),
  },
}))

import { apiClient } from '../src/api/client'

beforeEach(() => {
  postMock.mockReset()
  getMock.mockReset()
})

describe('apiClient.warmup — Render cold-start warm-up', () => {
  it('calls GET /health with a 120s timeout, retries up to 3 times, and never throws', async () => {
    getMock.mockRejectedValue(new Error('cold instance'))
    vi.useFakeTimers()
    try {
      const p = apiClient.warmup()
      // Two 10s sleeps happen between the 3 attempts.
      await vi.advanceTimersByTimeAsync(20000)
      await p
    } finally {
      vi.useRealTimers()
    }
    expect(getMock).toHaveBeenCalledTimes(3)
    for (const call of getMock.mock.calls) {
      expect(call[0]).toBe('/health')
      expect(call[1]).toMatchObject({ timeout: 120000 })
    }
  })

  it('resolves (does not reject) even when every attempt fails', async () => {
    getMock.mockRejectedValue(new Error('boom'))
    vi.useFakeTimers()
    const p = apiClient.warmup()
    await vi.advanceTimersByTimeAsync(20000)
    await expect(p).resolves.toBeUndefined()
    vi.useRealTimers()
  })

  it('returns early after a single successful health check (only 1 call)', async () => {
    getMock.mockResolvedValue({ data: { status: 'ok' } })
    await apiClient.warmup()
    expect(getMock).toHaveBeenCalledTimes(1)
    expect(getMock.mock.calls[0][0]).toBe('/health')
    expect(getMock.mock.calls[0][1]).toMatchObject({ timeout: 120000 })
  })

  it('retries after failures and succeeds on the 3rd attempt', async () => {
    getMock
      .mockRejectedValueOnce(new Error('cold'))
      .mockRejectedValueOnce(new Error('cold'))
      .mockResolvedValueOnce({ data: { status: 'ok' } })
    vi.useFakeTimers()
    try {
      const p = apiClient.warmup()
      await vi.advanceTimersByTimeAsync(20000)
      await p
    } finally {
      vi.useRealTimers()
    }
    expect(getMock).toHaveBeenCalledTimes(3)
    expect(getMock.mock.calls[2][1]).toMatchObject({ timeout: 120000 })
  })
})

describe('apiClient.upload — extended cold-start timeout', () => {
  it('POSTs /upload with FormData and timeout 300000 (file branch)', async () => {
    postMock.mockResolvedValue({ data: { taskId: 'task-1', status: 'queued' } })
    const file = new File(['x'], 'dance.mp4', { type: 'video/mp4' })
    const res = await apiClient.upload({ file })
    expect(postMock).toHaveBeenCalledTimes(1)
    const [url, body, config] = postMock.mock.calls[0]
    expect(url).toBe('/upload')
    expect(body).toBeInstanceOf(FormData)
    expect(config.timeout).toBe(300000)
    expect(res.taskId).toBe('task-1')
  })

  it('POSTs /upload with url payload (url branch falls back to global timeout)', async () => {
    // Per spec, only the file branch in client.ts overrides the timeout; the
    // url branch relies on the global 60000ms axios timeout (no 3rd arg).
    postMock.mockResolvedValue({ data: { taskId: 'task-2', status: 'queued' } })
    const res = await apiClient.upload({ url: 'https://example.com/v.mp4' })
    expect(postMock).toHaveBeenCalledTimes(1)
    const [url, body, config] = postMock.mock.calls[0]
    expect(url).toBe('/upload')
    expect(body).toEqual({ url: 'https://example.com/v.mp4' })
    expect(config).toBeUndefined()
    expect(res.taskId).toBe('task-2')
  })

  it('throws when neither file nor url is provided', async () => {
    postMock.mockResolvedValue({ data: {} })
    await expect(apiClient.upload({})).rejects.toThrow()
  })
})
