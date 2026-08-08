import type { AnalysisResult, TaskStatusValue } from '../types/api'

export interface LocalTask {
  taskId: string
  videoId: string
  videoName: string
  status: TaskStatusValue
  progress: number
  result: AnalysisResult | null
  error: string | null
  createdAt: string
}

const STORAGE_KEY = 'dance-teacher:local-tasks:v1'
const tasks = new Map<string, LocalTask>()
const listeners = new Set<(t: LocalTask | undefined) => void>()

function loadPersisted(): void {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return
    const map = JSON.parse(raw) as Record<string, LocalTask>
    for (const [id, t] of Object.entries(map)) tasks.set(id, t)
  } catch {
    // ignore corrupt cache
  }
}

function persist(): void {
  try {
    const map: Record<string, LocalTask> = {}
    for (const [id, t] of tasks) map[id] = t
    localStorage.setItem(STORAGE_KEY, JSON.stringify(map))
  } catch {
    // quota / private mode — in-memory still works for the session
  }
}

loadPersisted()

export function getTask(taskId: string): LocalTask | undefined {
  return tasks.get(taskId)
}

export function upsertTask(task: LocalTask): void {
  tasks.set(task.taskId, task)
  persist()
  for (const l of listeners) l(tasks.get(task.taskId))
}

export function subscribeTask(
  taskId: string,
  cb: (t: LocalTask | undefined) => void,
): () => void {
  listeners.add(cb)
  cb(tasks.get(taskId))
  return () => {
    listeners.delete(cb)
  }
}
