import { create } from 'zustand'
import type { ABLoop } from '../types/api'

/** Fine-grained modes lock one beat or one half of the current 8-count. */
export type FocusedLoopMode = 'current' | 'front' | 'back' | 'single'
/** All mutually exclusive loop modes shown in the lesson control bar. */
export type LoopMode = FocusedLoopMode | 'multi' | 'ab'

export function isFocusedLoopMode(mode: LoopMode): mode is FocusedLoopMode {
  return mode === 'current' || mode === 'front' || mode === 'back' || mode === 'single'
}

function validAB(abLoop: ABLoop | null): boolean {
  return abLoop != null && abLoop.aTime < abLoop.bTime
}

export interface LessonState {
  currentSegment: number
  playbackRate: number
  /** Video image mirror. */
  mirror: boolean
  /** Beat-overlay mirror, intentionally independent from the video image. */
  beatMirror: boolean
  /** One master switch shared by every loop mode. */
  loopEnabled: boolean
  loopMode: LoopMode
  loopSegmentIds: number[]
  abLoop: ABLoop | null
  voiceEnabled: boolean
  /** Confirmed beat-grid offset used by the player and segmentation. */
  beatOffset: number
  /** Slider draft; does not alter segmentation until explicitly confirmed. */
  draftBeatOffset: number
  loopCount: number | null
  practiceSeconds: number
  learnedSegments: number[]
  setSegment: (i: number) => void
  setPlaybackRate: (r: number) => void
  setMirror: (b: boolean) => void
  setBeatMirror: (b: boolean) => void
  setLoopEnabled: (b: boolean) => void
  toggleLoopEnabled: () => void
  setLoopMode: (m: LoopMode) => void
  toggleLoopSegmentId: (id: number) => void
  setLoopSegmentIds: (ids: number[]) => void
  setABLoop: (v: ABLoop | null) => void
  setVoiceEnabled: (b: boolean) => void
  setBeatOffset: (n: number) => void
  setDraftBeatOffset: (n: number) => void
  setLoopCount: (n: number | null) => void
  addPracticeSeconds: (seconds: number) => void
  toggleLearned: (i: number) => void
  setLearnedSegments: (arr: number[]) => void
  reset: () => void
}

function canEnableLoop(state: Pick<LessonState, 'loopMode' | 'loopSegmentIds' | 'abLoop'>) {
  if (state.loopMode === 'multi') return state.loopSegmentIds.length > 0
  if (state.loopMode === 'ab') return validAB(state.abLoop)
  return true
}

export const useLessonStore = create<LessonState>((set) => ({
  currentSegment: 1,
  playbackRate: 1,
  mirror: true,
  beatMirror: true,
  loopEnabled: false,
  loopMode: 'single',
  loopSegmentIds: [],
  abLoop: null,
  voiceEnabled: false,
  beatOffset: 0,
  draftBeatOffset: 0,
  loopCount: null,
  practiceSeconds: 0,
  learnedSegments: [],

  setSegment: (i) => set({ currentSegment: i }),
  setPlaybackRate: (r) => set({ playbackRate: r }),
  setMirror: (b) => set({ mirror: b }),
  setBeatMirror: (b) => set({ beatMirror: b }),
  setLoopEnabled: (b) =>
    set((state) => ({ loopEnabled: b && canEnableLoop(state) })),
  toggleLoopEnabled: () =>
    set((state) => ({
      loopEnabled: canEnableLoop(state) ? !state.loopEnabled : false,
    })),
  setLoopMode: (loopMode) =>
    set((state) => {
      const next = { ...state, loopMode }
      return {
        loopMode,
        loopEnabled: state.loopEnabled && canEnableLoop(next),
      }
    }),
  toggleLoopSegmentId: (id) =>
    set((state) => {
      const loopSegmentIds = state.loopSegmentIds.includes(id)
        ? state.loopSegmentIds.filter((x) => x !== id)
        : [...state.loopSegmentIds, id].sort((a, b) => a - b)
      return {
        loopSegmentIds,
        loopEnabled:
          state.loopMode === 'multi' && loopSegmentIds.length === 0
            ? false
            : state.loopEnabled,
      }
    }),
  setLoopSegmentIds: (ids) =>
    set((state) => {
      const loopSegmentIds = Array.from(new Set(ids)).sort((a, b) => a - b)
      return {
        loopSegmentIds,
        loopEnabled:
          state.loopMode === 'multi' && loopSegmentIds.length === 0
            ? false
            : state.loopEnabled,
      }
    }),
  setABLoop: (abLoop) =>
    set((state) => ({
      abLoop,
      loopEnabled:
        state.loopMode === 'ab' && !validAB(abLoop) ? false : state.loopEnabled,
    })),
  setVoiceEnabled: (b) => set({ voiceEnabled: b }),
  setBeatOffset: (n) => set({ beatOffset: n }),
  setDraftBeatOffset: (n) => set({ draftBeatOffset: n }),
  setLoopCount: (n) => set({ loopCount: n }),
  addPracticeSeconds: (seconds) =>
    set((state) => ({
      practiceSeconds: state.practiceSeconds + Math.max(0, seconds),
    })),
  toggleLearned: (i) =>
    set((state) => ({
      learnedSegments: state.learnedSegments.includes(i)
        ? state.learnedSegments.filter((x) => x !== i)
        : [...state.learnedSegments, i].sort((a, b) => a - b),
    })),
  setLearnedSegments: (arr) =>
    set({ learnedSegments: Array.from(new Set(arr)).sort((a, b) => a - b) }),
  reset: () =>
    set({
      currentSegment: 1,
      playbackRate: 1,
      mirror: true,
      beatMirror: true,
      loopEnabled: false,
      loopMode: 'single',
      loopSegmentIds: [],
      abLoop: null,
      voiceEnabled: false,
      beatOffset: 0,
      draftBeatOffset: 0,
      loopCount: null,
      practiceSeconds: 0,
      learnedSegments: [],
    }),
}))
