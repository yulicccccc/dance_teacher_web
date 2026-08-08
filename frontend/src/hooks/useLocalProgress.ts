import { useCallback, useEffect, useRef, useState } from 'react'
import type { AnalysisResult, ABLoop } from '../types/api'
import type { LoopMode } from '../store/lessonStore'

/**
 * Local-first progress store (PRD P0-9). Mirrors the schema in
 * `docs/system_design.md` §3.3. Key: `dance-teacher:progress:v1`.
 *
 * Results are usually < 50KB and live inline in localStorage. When a result
 * exceeds the threshold we transparently move it into IndexedDB (under
 * `result:<videoId>`) and keep only a pointer in localStorage, so callers are
 * none the wiser.
 */
const STORAGE_KEY = 'dance-teacher:progress:v1'
const SIZE_THRESHOLD = 50 * 1024 // 50KB
const DB_NAME = 'dance-teacher-progress'
const STORE_NAME = 'results'

export interface LessonProgress {
  currentSegment: number
  playbackRate: number
  mirror: boolean
  beatMirror: boolean
  loopEnabled: boolean
  loopMode: LoopMode
  loopSegmentIds: number[]
  loopCount: number | null
  practiceSeconds: number
  voiceEnabled: boolean
  beatOffset: number
  learnedSegments: number[]
  /** Custom A→B loop (beat-anchored). Optional so old progress blobs without it
   *  still hydrate; treated as `null` when missing. */
  abLoop?: ABLoop | null
  updatedAt: string
}

/** Legacy v1 shape kept only for migration of already-saved browser data. */
type LegacyLessonProgress = Partial<LessonProgress> & {
  loopSegment?: boolean
}

export interface CourseProgress {
  videoName: string
  taskId: string
  result: AnalysisResult
  progress: LessonProgress
  _resultKey?: string
}

export interface ProgressStore {
  version: number
  courses: Record<string, CourseProgress>
}

// ---- Pure helpers (exported for unit testing) --------------------------
/** De-duplicate and sort learned-segment ids ascending. */
export function sortSegments(arr: number[]): number[] {
  return Array.from(new Set(arr)).sort((a, b) => a - b)
}

/** Upgrade old progress blobs to the loop-redesign schema without data loss. */
export function normalizeLessonProgress(raw: LegacyLessonProgress): LessonProgress {
  const abLoop = raw.abLoop ?? null
  const loopMode: LoopMode =
    raw.loopMode === 'single' || raw.loopMode === 'multi' || raw.loopMode === 'ab'
      ? raw.loopMode
      : abLoop?.enabled
        ? 'ab'
        : 'single'
  const loopSegmentIds = sortSegments(raw.loopSegmentIds ?? [])
  const requestedEnabled =
    raw.loopEnabled ?? raw.loopSegment ?? Boolean(abLoop?.enabled)
  const validForMode =
    loopMode === 'single' ||
    (loopMode === 'multi' && loopSegmentIds.length > 0) ||
    (loopMode === 'ab' && abLoop != null && abLoop.aTime < abLoop.bTime)

  return {
    currentSegment: raw.currentSegment ?? 1,
    playbackRate: raw.playbackRate ?? 1,
    mirror: raw.mirror ?? true,
    beatMirror: raw.beatMirror ?? raw.mirror ?? true,
    loopEnabled: requestedEnabled && validForMode,
    loopMode,
    loopSegmentIds,
    loopCount: raw.loopCount ?? null,
    practiceSeconds: raw.practiceSeconds ?? 0,
    voiceEnabled: raw.voiceEnabled ?? false,
    beatOffset: raw.beatOffset ?? 0,
    learnedSegments: sortSegments(raw.learnedSegments ?? []),
    abLoop,
    updatedAt: raw.updatedAt ?? new Date(0).toISOString(),
  }
}

// ---- IndexedDB helpers (fallback for large results) ---------------------
function openDB(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1)
    req.onupgradeneeded = () => {
      const db = req.result
      if (!db.objectStoreNames.contains(STORE_NAME)) db.createObjectStore(STORE_NAME)
    }
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error)
  })
}

async function idbGet(key: string): Promise<unknown | undefined> {
  try {
    const db = await openDB()
    return await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readonly')
      const req = tx.objectStore(STORE_NAME).get(key)
      req.onsuccess = () => resolve(req.result)
      req.onerror = () => reject(req.error)
      db.close()
    })
  } catch {
    return undefined
  }
}

async function idbSet(key: string, value: unknown): Promise<void> {
  try {
    const db = await openDB()
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readwrite')
      tx.objectStore(STORE_NAME).put(value, key)
      tx.oncomplete = () => resolve()
      tx.onerror = () => reject(tx.error)
      db.close()
    })
  } catch {
    // best effort; localStorage fallback will be attempted
  }
}

export async function loadStore(): Promise<ProgressStore> {
  const empty: ProgressStore = { version: 1, courses: {} }
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return empty
    const store = JSON.parse(raw) as ProgressStore
    store.courses = store.courses || {}
    for (const course of Object.values(store.courses)) {
      course.progress = normalizeLessonProgress(
        course.progress as unknown as LegacyLessonProgress,
      )
      if (course.result == null && course._resultKey) {
        const res = await idbGet(course._resultKey)
        if (res) course.result = res as AnalysisResult
      }
    }
    return store
  } catch {
    return empty
  }
}

export async function saveStore(store: ProgressStore): Promise<void> {
  const toSave: ProgressStore = { version: 1, courses: {} }
  const persist = async (target: ProgressStore) => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(target))
  }
  for (const [vid, course] of Object.entries(store.courses)) {
    const resultJson = JSON.stringify(course.result)
    if (resultJson.length > SIZE_THRESHOLD && typeof indexedDB !== 'undefined') {
      const key = `result:${vid}`
      await idbSet(key, course.result)
      toSave.courses[vid] = {
        ...course,
        result: undefined as unknown as AnalysisResult,
        _resultKey: key,
      }
    } else {
      toSave.courses[vid] = course
    }
  }
  try {
    await persist(toSave)
  } catch {
    // quota still exceeded: push every result to IDB and retry
    try {
      for (const [vid, course] of Object.entries(store.courses)) {
        const key = `result:${vid}`
        await idbSet(key, course.result)
        toSave.courses[vid] = {
          ...course,
          result: undefined as unknown as AnalysisResult,
          _resultKey: key,
        }
      }
      await persist(toSave)
    } catch {
      // give up gracefully; in-memory state still works for this session
    }
  }
}

// ---- Hook ---------------------------------------------------------------
export function useLocalProgress() {
  const storeRef = useRef<ProgressStore>({ version: 1, courses: {} })
  const [ready, setReady] = useState(false)

  useEffect(() => {
    let cancelled = false
    void (async () => {
      const store = await loadStore()
      if (!cancelled) {
        storeRef.current = store
        setReady(true)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [])

  const persist = useCallback(async () => {
    await saveStore(storeRef.current)
  }, [])

  const getCourse = useCallback((videoId: string): CourseProgress | undefined => {
    return storeRef.current.courses[videoId]
  }, [])

  const getAll = useCallback((): Record<string, CourseProgress> => {
    return storeRef.current.courses
  }, [])

  const saveCourse = useCallback(
    async (videoId: string, course: CourseProgress) => {
      storeRef.current.courses[videoId] = course
      await persist()
    },
    [persist],
  )

  const updateProgress = useCallback(
    async (videoId: string, patch: Partial<LessonProgress>) => {
      const c = storeRef.current.courses[videoId]
      if (!c) return
      c.progress = { ...c.progress, ...patch, updatedAt: new Date().toISOString() }
      await persist()
    },
    [persist],
  )

  const markLearned = useCallback(
    async (videoId: string, seg: number, learned: boolean) => {
      const c = storeRef.current.courses[videoId]
      if (!c) return
      const set = new Set(c.progress.learnedSegments)
      if (learned) set.add(seg)
      else set.delete(seg)
      c.progress.learnedSegments = sortSegments(Array.from(set))
      c.progress.updatedAt = new Date().toISOString()
      await persist()
    },
    [persist],
  )

  return { ready, getCourse, getAll, saveCourse, updateProgress, markLearned }
}
