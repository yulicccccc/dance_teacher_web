import { describe, it, expect, beforeEach } from 'vitest'
import { useLessonStore } from '../src/store/lessonStore'
import {
  loadStore,
  saveStore,
  type CourseProgress,
  type LessonProgress,
} from '../src/hooks/useLocalProgress'
import { findBeatAt } from '../src/utils/segmentMath'
import type { AnalysisResult, Segment, ABLoop } from '../src/types/api'

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
    beatOffset: 0,
    learnedSegments: [],
    updatedAt: '2026-07-24T00:00:00Z',
    ...over,
  }
}
function course(videoId: string, result: AnalysisResult, p: LessonProgress): CourseProgress {
  return { videoName: result.videoName, taskId: result.taskId, result, progress: p }
}
const abEnabled: ABLoop = {
  enabled: true,
  aTime: 2.0,
  bTime: 6.0,
  aBeat: 5,
  bBeat: 13,
}
describe('lessonStore — one master loop switch with six modes', () => {
  beforeEach(() => {
    useLessonStore.getState().reset()
  })

  it('mode switching preserves AB points but only the selected mode runs', () => {
    useLessonStore.getState().setABLoop(abEnabled)
    useLessonStore.getState().setLoopMode('ab')
    useLessonStore.getState().setLoopEnabled(true)
    expect(useLessonStore.getState().loopEnabled).toBe(true)
    useLessonStore.getState().setLoopMode('single')
    expect(useLessonStore.getState().loopEnabled).toBe(true)
    expect(useLessonStore.getState().abLoop).toEqual(abEnabled)
  })

  it('clearing AB while AB mode is active disables the master loop', () => {
    useLessonStore.getState().setABLoop(abEnabled)
    useLessonStore.getState().setLoopMode('ab')
    useLessonStore.getState().setLoopEnabled(true)
    useLessonStore.getState().setABLoop(null)
    expect(useLessonStore.getState().loopEnabled).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// GAP 2: useLocalProgress 持久化/恢复 abLoop (原测试未覆盖)
// ---------------------------------------------------------------------------
describe('useLocalProgress — abLoop 持久化 round-trip (QA 独立补充)', () => {
  beforeEach(() => {
    localStorage.clear()
  })

  it('内联保存/恢复包含 abLoop 的进度', async () => {
    const store = {
      version: 1,
      courses: {
        vidA: course('vidA', smallResult(), progress({ abLoop: abEnabled })),
      },
    }
    await saveStore(store)
    const loaded = await loadStore()
    expect(loaded.courses.vidA.progress.abLoop).toEqual(abEnabled)
  })

  it('不带 abLoop 的旧进度会迁移为明确的 null', async () => {
    const store = {
      version: 1,
      courses: { vidB: course('vidB', smallResult(), progress()) }, // 无 abLoop
    }
    await saveStore(store)
    const loaded = await loadStore()
    expect(loaded.courses.vidB.progress.abLoop).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// GAP 3: findBeatAt 段间空隙边界 (原只有首拍前/末拍后，缺段间空隙)
// ---------------------------------------------------------------------------
describe('findBeatAt — 段间空隙边界 (QA 独立补充)', () => {
  it('time 落在两段之间的空隙时回退到前一段的最后一拍', () => {
    const gapped: Segment[] = [
      { index: 1, startTime: 0, endTime: 4, type: 'dance', beats: [0, 0.5, 1, 1.5, 2, 2.5, 3, 3.5] },
      { index: 2, startTime: 6, endTime: 10, type: 'dance', beats: [6, 6.5, 7, 7.5, 8, 8.5, 9, 9.5] },
    ]
    const hit = findBeatAt(gapped, 5.0) // 3.5 与 6.0 之间的空隙
    expect(hit).not.toBeNull()
    expect(hit!.segIndex).toBe(1) // 仍归属前一段
    expect(hit!.beatTime).toBeCloseTo(3.5) // 对齐到前一段末拍，而非裸 currentTime(5.0)
    expect(hit!.beatInSeg).toBe(8)
  })
})
