import { useEffect, useState } from 'react'
import { getTask, subscribeTask, type LocalTask } from '../store/analysisStore'

/**
 * Subscribe to a local analysis task's progress. Replaces the backend polling
 * hook — the task state is published by `localAnalysis.startLocalAnalysis`.
 */
export function useLocalAnalysis(taskId: string | undefined) {
  const [task, setTask] = useState<LocalTask | undefined>(() =>
    taskId ? getTask(taskId) : undefined,
  )

  useEffect(() => {
    if (!taskId) {
      setTask(undefined)
      return
    }
    setTask(getTask(taskId))
    return subscribeTask(taskId, setTask)
  }, [taskId])

  return { task }
}
