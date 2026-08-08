import { useCallback, useEffect, useRef, useState } from 'react'
import { apiClient } from '../api/client'
import type { TaskStatus } from '../types/api'

const POLL_INTERVAL = 1000 // ms, per shared convention

/**
 * Poll `GET /analysis/{taskId}` every 1000ms until the task is `done` or
 * `failed`. Exposes the latest status, an error channel, and a `retry` that
 * re-arms polling after a failed task restarts.
 */
export function useAnalysisPolling(taskId: string | undefined) {
  const [status, setStatus] = useState<TaskStatus | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState<boolean>(true)
  const timer = useRef<number | null>(null)

  const stop = useCallback(() => {
    if (timer.current !== null) {
      window.clearInterval(timer.current)
      timer.current = null
    }
  }, [])

  const pollOnce = useCallback(async () => {
    if (!taskId) return
    try {
      const s = await apiClient.getStatus(taskId)
      setStatus(s)
      setError(null)
      if (s.status === 'done' || s.status === 'failed') {
        stop()
        setLoading(false)
      }
    } catch (e) {
      setError((e as Error).message)
    }
  }, [taskId, stop])

  useEffect(() => {
    if (!taskId) {
      setLoading(false)
      return
    }
    setLoading(true)
    setStatus(null)
    setError(null)
    stop()
    timer.current = window.setInterval(pollOnce, POLL_INTERVAL)
    void pollOnce()
    return stop
  }, [taskId, pollOnce, stop])

  const retry = useCallback(async () => {
    if (!taskId) return
    setError(null)
    setStatus(null)
    setLoading(true)
    await apiClient.retry(taskId)
    stop()
    timer.current = window.setInterval(pollOnce, POLL_INTERVAL)
    void pollOnce()
  }, [taskId, pollOnce, stop])

  return { status, error, loading, retry, stop }
}
