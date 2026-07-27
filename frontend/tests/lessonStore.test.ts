import { describe, it, expect } from 'vitest'
import { useLessonStore } from '../src/store/lessonStore'

describe('lessonStore (P0-10 learned marking + currentSegment recovery)', () => {
  it('has correct defaults (mirror on, segment 1)', () => {
    const s = useLessonStore.getState()
    expect(s.mirror).toBe(true)
    expect(s.currentSegment).toBe(1)
    expect(s.loopSegment).toBe(false)
    expect(s.voiceEnabled).toBe(false)
    expect(s.learnedSegments).toEqual([])
  })

  it('setSegment updates the current segment', () => {
    useLessonStore.getState().setSegment(3)
    expect(useLessonStore.getState().currentSegment).toBe(3)
    useLessonStore.getState().reset()
  })

  it('toggleLearned adds, removes and keeps ascending order', () => {
    const { toggleLearned } = useLessonStore.getState()
    toggleLearned(2)
    toggleLearned(1)
    toggleLearned(3)
    expect(useLessonStore.getState().learnedSegments).toEqual([1, 2, 3])
    toggleLearned(2)
    expect(useLessonStore.getState().learnedSegments).toEqual([1, 3])
    toggleLearned(1)
    toggleLearned(3)
    expect(useLessonStore.getState().learnedSegments).toEqual([])
    useLessonStore.getState().reset()
  })

  it('setLearnedSegments dedupes and sorts ascending', () => {
    // Now consistent with toggleLearned: duplicates are removed, then sorted.
    useLessonStore.getState().setLearnedSegments([3, 1, 2, 2, 3])
    expect(useLessonStore.getState().learnedSegments).toEqual([1, 2, 3])
    useLessonStore.getState().reset()
  })

  it('reset restores defaults', () => {
    useLessonStore.getState().setSegment(5)
    useLessonStore.getState().setMirror(false)
    useLessonStore.getState().setLearnedSegments([1, 2])
    useLessonStore.getState().reset()
    const s = useLessonStore.getState()
    expect(s.currentSegment).toBe(1)
    expect(s.mirror).toBe(true)
    expect(s.learnedSegments).toEqual([])
  })
})
