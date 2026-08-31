import { describe, it, expect } from 'vitest'
import { useLessonStore } from '../src/store/lessonStore'

describe('lessonStore (P0-10 learned marking + currentSegment recovery)', () => {
  it('has correct defaults (mirror on, segment 1)', () => {
    const s = useLessonStore.getState()
    expect(s.mirror).toBe(true)
    expect(s.currentSegment).toBe(1)
    expect(s.beatMirror).toBe(true)
    expect(s.loopEnabled).toBe(false)
    expect(s.loopMode).toBe('single')
    expect(s.practiceSeconds).toBe(0)
    expect(s.voiceEnabled).toBe(false)
    expect(s.voiceVolume).toBe(1)
    expect(s.metronomeEnabled).toBe(false)
    expect(s.metronomeSound).toBe('click')
    expect(s.metronomeRate).toBe('normal')
    expect(s.metronomeVolume).toBe(0.8)
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
    expect(s.voiceVolume).toBe(1)
    expect(s.metronomeEnabled).toBe(false)
    expect(s.metronomeSound).toBe('click')
    expect(s.metronomeRate).toBe('normal')
    expect(s.metronomeVolume).toBe(0.8)
  })

  it('sets count-command volume and clamps it to 0–200%', () => {
    useLessonStore.getState().setVoiceVolume(1.65)
    expect(useLessonStore.getState().voiceVolume).toBe(1.65)
    useLessonStore.getState().setVoiceVolume(3)
    expect(useLessonStore.getState().voiceVolume).toBe(2)
    useLessonStore.getState().setVoiceVolume(-1)
    expect(useLessonStore.getState().voiceVolume).toBe(0)
    useLessonStore.getState().reset()
  })

  it('persists the selected metronome sound and clamps its independent volume', () => {
    const store = useLessonStore.getState()
    store.setMetronomeEnabled(true)
    store.setMetronomeSound('wood')
    store.setMetronomeRate('double')
    store.setMetronomeVolume(1.6)
    expect(useLessonStore.getState().metronomeEnabled).toBe(true)
    expect(useLessonStore.getState().metronomeSound).toBe('wood')
    expect(useLessonStore.getState().metronomeRate).toBe('double')
    expect(useLessonStore.getState().metronomeVolume).toBe(1.6)
    store.setMetronomeVolume(3)
    expect(useLessonStore.getState().metronomeVolume).toBe(2)
    store.setMetronomeVolume(-1)
    expect(useLessonStore.getState().metronomeVolume).toBe(0)
    store.reset()
  })

  it('multi mode requires a selection and clearing the last item disables looping', () => {
    const store = useLessonStore.getState()
    store.setLoopMode('multi')
    store.setLoopEnabled(true)
    expect(useLessonStore.getState().loopEnabled).toBe(false)
    store.toggleLoopSegmentId(2)
    store.setLoopEnabled(true)
    expect(useLessonStore.getState().loopEnabled).toBe(true)
    store.toggleLoopSegmentId(2)
    expect(useLessonStore.getState().loopEnabled).toBe(false)
    useLessonStore.getState().reset()
  })

  it('AB mode requires A before B', () => {
    const store = useLessonStore.getState()
    store.setLoopMode('ab')
    store.setABLoop({ enabled: false, aTime: 4, bTime: 2, aBeat: 8, bBeat: 4 })
    store.setLoopEnabled(true)
    expect(useLessonStore.getState().loopEnabled).toBe(false)
    store.setABLoop({ enabled: false, aTime: 2, bTime: 4, aBeat: 4, bBeat: 8 })
    store.setLoopEnabled(true)
    expect(useLessonStore.getState().loopEnabled).toBe(true)
    useLessonStore.getState().reset()
  })

  it('accumulates practice time and resets it per course', () => {
    useLessonStore.getState().addPracticeSeconds(5)
    useLessonStore.getState().addPracticeSeconds(3)
    expect(useLessonStore.getState().practiceSeconds).toBe(8)
    useLessonStore.getState().reset()
    expect(useLessonStore.getState().practiceSeconds).toBe(0)
  })
})
