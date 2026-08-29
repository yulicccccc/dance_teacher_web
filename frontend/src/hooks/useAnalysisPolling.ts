import { useCallback, useEffect, useRef, useState } from 'react'
import type { AxiosError } from 'axios'
import { apiClient, extractApiError } from '../api/client'
import type { TaskStatus } from '../types/api'

const POLL_INTERVAL = 2000
const MAX_TRANSIENT_DELAY = 30000

/**
 * Poll `GET /analysis/{taskId}` every 1000ms until the task is `done` or
 * `failed`. Exposes the latest status, an error channel, and a `retry` that
 * re-arms polling after a failed task restarts.
 */
export function useAnalysisPolling(taskId: string | undefined) {
  const [status, setStatus] = useState<TaskStatus | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [loading, setLoading] = useState<boolean>(true)
  const cancelCurrent = useRef<() => void>(() => undefined)
  const [pollGeneration, setPollGeneration] = useState(0)

  const stop = useCallback(() => {
    cancelCurrent.current()
  }, [])

  useEffect(() => {
    if (!taskId) {
      setLoading(false)
      return
    }

    let cancelled = false
    let timer: number | null = null
    let transientFailures = 0

    const cancel = () => {
      cancelled = true
      if (timer !== null) {
        window.clearTimeout(timer)
        timer = null
      }
    }
    cancelCurrent.current = cancel

    const schedule = (delay: number) => {
      if (cancelled) return
      timer = window.setTimeout(() => void pollOnce(), delay)
    }

    const pollOnce = async () => {
      if (cancelled) return
      try {
        const nextStatus = await apiClient.getStatus(taskId)
        if (cancelled) return
        transientFailures = 0
        setStatus(nextStatus)
        setError(null)
        setNotice(null)
        if (nextStatus.status === 'done' || nextStatus.status === 'failed') {
          setLoading(false)
          return
        }
        schedule(POLL_INTERVAL)
      } catch (caught) {
        if (cancelled) return
        const httpStatus = (caught as AxiosError)?.response?.status
        const transient =
          httpStatus == null || httpStatus === 408 || httpStatus === 429 || httpStatus >= 500
        if (!transient) {
          setError(extractApiError(caught).message)
          setNotice(null)
          setLoading(false)
          return
        }

        transientFailures += 1
        setError(null)
        setNotice('线上服务暂时繁忙，正在自动等待并继续分析，不需要重新上传。')
        const baseDelay = httpStatus === 429 ? 15000 : 5000
        const delay = Math.min(
          baseDelay * 2 ** Math.min(transientFailures - 1, 2),
          MAX_TRANSIENT_DELAY,
        )
        schedule(delay)
      }
    }

    setLoading(true)
    setStatus(null)
    setError(null)
    setNotice(null)
    void pollOnce()
    return cancel
  }, [taskId, pollGeneration])

  const retry = useCallback(async () => {
    if (!taskId) return
    stop()
    setError(null)
    setNotice(null)
    setStatus(null)
    setLoading(true)
    await apiClient.retry(taskId)
    setPollGeneration((generation) => generation + 1)
  }, [taskId, stop])

  return { status, error, notice, loading, retry, stop }
}
