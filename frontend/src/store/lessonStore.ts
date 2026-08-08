import { create } from 'zustand'
import type { ABLoop } from '../types/api'

/**
 * Runtime state for the lesson player. Persisted to localStorage/IndexedDB by
 * `useLocalProgress` (T05). Mirror defaults to `true` to simulate the dance-studio
 * mirror view for single-camera footage.
 */
/**
 * Loop behaviour: `single` loops the segment the playhead is in (padded by one
 * beat each side); `multi` loops only the subset of segments the user ticked
 * in the LoopPanel, each also padded, cycling through them and wrapping the
 * last back to the first.
 */
export type LoopMode = 'single' | 'multi'

export interface LessonState {
  currentSegment: number
  playbackRate: number
  mirror: boolean
  loopSegment: boolean
  abLoop: ABLoop | null
  voiceEnabled: boolean
  beatOffset: number // manual beat-grid offset in BEATS (display only), default 0
  loopCount: number | null // loop repetition limit; null = infinite
  learnedSegments: number[]
  /** Which loop flavour is active when looping is on. */
  loopMode: LoopMode
  /** Segment indices (1-based, matching `Segment.index`) ticked for multi-loop. */
  loopSegmentIds: number[]
  setSegment: (i: number) => void
  setPlaybackRate: (r: number) => void
  setMirror: (b: boolean) => void
  setLoopSegment: (b: boolean) => void
  setABLoop: (v: ABLoop | null) => void
  setVoiceEnabled: (b: boolean) => void
  setBeatOffset: (n: number) => void
  setLoopCount: (n: number | null) => void
  toggleLearned: (i: number) => void
  setLearnedSegments: (arr: number[]) => void
  setLoopMode: (m: LoopMode) => void
  toggleLoopSegmentId: (id: number) => void
  setLoopSegmentIds: (ids: number[]) => void
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
  loopCount: null,
  learnedSegments: [],
  loopMode: 'single',
  loopSegmentIds: [],

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
  setLoopCount: (n) => set({ loopCount: n }),
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
      loopCount: null,
      learnedSegments: [],
      loopMode: 'single',
      loopSegmentIds: [],
    }),
  setLearnedSegments: (arr) =>
    set({ learnedSegments: Array.from(new Set(arr)).sort((a, b) => a - b) }),
  // Switch the loop flavour. Does not toggle looping itself — the master
  // `loopSegment` switch (ControlBar "单节循环") keeps governing whether any
  // loop runs; `multi` + an empty selection simply degrades to single behaviour.
  setLoopMode: (m) => set({ loopMode: m }),
  // Tick / un-tick a single segment for the multi-segment loop.
  toggleLoopSegmentId: (id) =>
    set((s) => ({
      loopSegmentIds: s.loopSegmentIds.includes(id)
        ? s.loopSegmentIds.filter((x) => x !== id)
        : [...s.loopSegmentIds, id].sort((a, b) => a - b),
    })),
  // Replace the whole multi-segment selection (used by "select all / clear").
  setLoopSegmentIds: (ids) =>
    set({ loopSegmentIds: Array.from(new Set(ids)).sort((a, b) => a - b) }),
}))
