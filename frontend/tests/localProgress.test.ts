import { describe, it, expect, beforeEach } from 'vitest'
import {
  loadStore,
  saveStore,
  sortSegments,
  normalizeLessonProgress,
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
    beatMirror: true,
    loopEnabled: false,
    loopMode: 'single',
    loopSegmentIds: [],
    loopCount: null,
    practiceSeconds: 0,
    voiceEnabled: false,
    voiceVolume: 1,
    metronomeEnabled: false,
    metronomeSound: 'click',
    metronomeVolume: 0.8,
    beatOffset: 0,
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

describe('loop progress migration', () => {
  it('migrates the legacy loopSegment switch to single-mode master loop', () => {
    const migrated = normalizeLessonProgress({
      currentSegment: 2,
      playbackRate: 0.75,
      mirror: false,
      loopSegment: true,
      voiceEnabled: true,
      learnedSegments: [2],
    })
    expect(migrated.loopMode).toBe('single')
    expect(migrated.loopEnabled).toBe(true)
    expect(migrated.beatMirror).toBe(false)
    expect(migrated.voiceVolume).toBe(1)
  })

  it('restores and clamps the saved count-command volume', () => {
    expect(normalizeLessonProgress({ voiceVolume: 1.7 }).voiceVolume).toBe(1.7)
    expect(normalizeLessonProgress({ voiceVolume: 9 }).voiceVolume).toBe(2)
    expect(normalizeLessonProgress({ voiceVolume: -2 }).voiceVolume).toBe(0)
  })

  it('migrates and clamps metronome preferences for old and new courses', () => {
    const legacy = normalizeLessonProgress({})
    expect(legacy.metronomeEnabled).toBe(false)
    expect(legacy.metronomeSound).toBe('click')
    expect(legacy.metronomeVolume).toBe(0.8)

    const saved = normalizeLessonProgress({
      metronomeEnabled: true,
      metronomeSound: 'wood',
      metronomeVolume: 9,
    })
    expect(saved.metronomeEnabled).toBe(true)
    expect(saved.metronomeSound).toBe('wood')
    expect(saved.metronomeVolume).toBe(2)
  })

  it('migrates an enabled legacy AB loop into AB mode', () => {
    const migrated = normalizeLessonProgress({
      abLoop: { enabled: true, aTime: 2, bTime: 6, aBeat: 5, bBeat: 13 },
    })
    expect(migrated.loopMode).toBe('ab')
    expect(migrated.loopEnabled).toBe(true)
  })

  it.each(['current', 'front', 'back'] as const)(
    'preserves the new %s fine-practice mode',
    (loopMode) => {
      const migrated = normalizeLessonProgress({ loopMode, loopEnabled: true })
      expect(migrated.loopMode).toBe(loopMode)
      expect(migrated.loopEnabled).toBe(true)
    },
  )
})

describe('useLocalProgress persistence (P0-9)', () => {
  beforeEach(() => {
    localStorage.clear()
  })

  it('round-trips a small result inline through localStorage', async () => {
    const store = {
      version: 1,
      courses: {
        vid1: course(
          'vid1',
          smallResult(),
          progress({ currentSegment: 2, practiceSeconds: 65 }),
        ),
      },
    }
    await saveStore(store)
    const loaded = await loadStore()
    expect(loaded.courses.vid1.result).toEqual(smallResult())
    expect(loaded.courses.vid1.progress.currentSegment).toBe(2)
    expect(loaded.courses.vid1.progress.practiceSeconds).toBe(65)
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
