import { describe, it, expect, beforeEach } from 'vitest'
import {
  loadStore,
  saveStore,
  sortSegments,
  type CourseProgress,
  type LessonProgress,
} from '../src/hooks/useLocalProgress'
import type { AnalysisResult, Segment } from '../src/types/api'

const STORAGE_KEY = 'dance-teacher:progress:v1'

function segment(i: number): Segment {
  return {
    index: i,
    startTime: (i - 1) * 4,
    endTime: (i - 1) * 4 + 4,
    type: 'dance',
    beats: Array.from({ length: 8 }, (_, k) => (i - 1) * 4 + k * 0.5),
  }
}

function smallResult(): AnalysisResult {
  return {
    taskId: 't-small',
    videoName: 'small.mp4',
    bpm: 120,
    confidence: 0.9,
    duration: 8,
    createdAt: '2026-07-24T00:00:00Z',
    segments: [segment(1), segment(2)],
  }
}

function bigResult(): AnalysisResult {
  // ~thousands of segments -> far exceeds the 50KB inline threshold
  return {
    taskId: 't-big',
    videoName: 'big.mp4',
    bpm: 120,
    confidence: 0.9,
    duration: 9999,
    createdAt: '2026-07-24T00:00:00Z',
    segments: Array.from({ length: 3000 }, (_, i) => segment(i + 1)),
  }
}

function progress(over: Partial<LessonProgress> = {}): LessonProgress {
  return {
    currentSegment: 1,
    playbackRate: 1,
    mirror: true,
    loopSegment: false,
    voiceEnabled: false,
    learnedSegments: [],
    updatedAt: '2026-07-24T00:00:00Z',
    ...over,
  }
}

function course(videoId: string, result: AnalysisResult, p: LessonProgress): CourseProgress {
  return { videoName: result.videoName, taskId: result.taskId, result, progress: p }
}

describe('sortSegments (pure helper)', () => {
  it('de-duplicates and sorts ascending', () => {
    expect(sortSegments([3, 1, 2, 1])).toEqual([1, 2, 3])
  })
})

describe('useLocalProgress persistence (P0-9)', () => {
  beforeEach(() => {
    localStorage.clear()
  })

  it('round-trips a small result inline through localStorage', async () => {
    const store = {
      version: 1,
      courses: { vid1: course('vid1', smallResult(), progress({ currentSegment: 2 })) },
    }
    await saveStore(store)
    const loaded = await loadStore()
    expect(loaded.courses.vid1.result).toEqual(smallResult())
    expect(loaded.courses.vid1.progress.currentSegment).toBe(2)
  })

  it('offloads a large result to IndexedDB and restores it transparently', async () => {
    const store = {
      version: 1,
      courses: { vid2: course('vid2', bigResult(), progress()) },
    }
    await saveStore(store)

    // In localStorage only a pointer remains; the result body is gone.
    const persisted = JSON.parse(localStorage.getItem(STORAGE_KEY) as string)
    expect(persisted.courses.vid2._resultKey).toBe('result:vid2')
    expect(persisted.courses.vid2.result).toBeUndefined()

    // loadStore transparently rehydrates the result from IndexedDB.
    const loaded = await loadStore()
    expect(loaded.courses.vid2.result).toEqual(bigResult())
  })

  it('restores currentSegment for break-point resume', async () => {
    const store = {
      version: 1,
      courses: { vid3: course('vid3', smallResult(), progress({ currentSegment: 7 })) },
    }
    await saveStore(store)
    const loaded = await loadStore()
    expect(loaded.courses.vid3.progress.currentSegment).toBe(7)
  })

  it('returns an empty store when nothing is persisted', async () => {
    const loaded = await loadStore()
    expect(loaded.courses).toEqual({})
  })
})
