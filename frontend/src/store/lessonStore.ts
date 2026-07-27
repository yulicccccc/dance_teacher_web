import { create } from 'zustand'
import type { ABLoop } from '../types/api'

/**
 * Runtime state for the lesson player. Persisted to localStorage/IndexedDB by
 * `useLocalProgress` (T05). Mirror defaults to `true` to simulate the dance-studio
 * mirror view for single-camera footage.
 */
export interface LessonState {
  currentSegment: number
  playbackRate: number
  mirror: boolean
  loopSegment: boolean
  abLoop: ABLoop | null
  voiceEnabled: boolean
  beatOffset: number // manual beat-grid offset in BEATS (display only), default 0
  learnedSegments: number[]
  setSegment: (i: number) => void
  setPlaybackRate: (r: number) => void
  setMirror: (b: boolean) => void
  setLoopSegment: (b: boolean) => void
  setABLoop: (v: ABLoop | null) => void
  setVoiceEnabled: (b: boolean) => void
  setBeatOffset: (n: number) => void
  toggleLearned: (i: number) => void
  setLearnedSegments: (arr: number[]) => void
  reset: () => void
}

export const useLessonStore = create<LessonState>((set) => ({
  currentSegment: 1,
  playbackRate: 1,
  mirror: true,
  loopSegment: false,
  abLoop: null,
  voiceEnabled: false,
  beatOffset: 0,
  learnedSegments: [],

  setSegment: (i) => set({ currentSegment: i }),
  setPlaybackRate: (r) => set({ playbackRate: r }),
  setMirror: (b) => set({ mirror: b }),
  // Enabling the single-segment loop clears any custom A→B loop: the two loop
  // modes are mutually exclusive (AB is beat-anchored, single-seg is phrase-
  // anchored) and running both would fight over the playhead.
  setLoopSegment: (b) =>
    set(b ? { loopSegment: true, abLoop: null } : { loopSegment: false }),
  // Enabling the A→B loop turns the single-segment loop off (mutual
  // exclusivity). Disabling or clearing AB leaves the single-segment loop as-is.
  setABLoop: (v) =>
    set(v && v.enabled ? { abLoop: v, loopSegment: false } : { abLoop: v }),
  setVoiceEnabled: (b) => set({ voiceEnabled: b }),
  setBeatOffset: (n) => set({ beatOffset: n }),
  toggleLearned: (i) =>
    set((s) => ({
      learnedSegments: s.learnedSegments.includes(i)
        ? s.learnedSegments.filter((x) => x !== i)
        : [...s.learnedSegments, i].sort((a, b) => a - b),
    })),
  reset: () =>
    set({
      currentSegment: 1,
      playbackRate: 1,
      mirror: true,
      loopSegment: false,
      abLoop: null,
      voiceEnabled: false,
      beatOffset: 0,
      learnedSegments: [],
    }),
  setLearnedSegments: (arr) =>
    set({ learnedSegments: Array.from(new Set(arr)).sort((a, b) => a - b) }),
}))
