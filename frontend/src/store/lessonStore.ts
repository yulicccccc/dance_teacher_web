import { create } from 'zustand'
import type { ABLoop } from '../types/api'

/**
 * Runtime state for the lesson player. Persisted to localStorage/IndexedDB by
 * `useLocalProgress` (T05). Mirror defaults to `true` to simulate the dance-studio
 * mirror view for single-camera footage.
 */
/**
 * Loop behaviour: `single` loops the segment the playhead is in (padded by one
 * beat each side); `multi` merges contiguous ticks into one loop block, pads
 * the block by one beat, and cycles through non-contiguous blocks.
 */
export type LoopMode = 'single' | 'multi'

export interface LessonState {
  currentSegment: number
  playbackRate: number
  mirror: boolean
  /** Mirror ONLY the beat overlay (count/dots), independent of the video mirror. */
  beatMirror: boolean
  loopSegment: boolean
  abLoop: ABLoop | null
  voiceEnabled: boolean
  beatOffset: number // manual beat-grid offset in BEATS (display only), default 0
  // Draft beat offset while the slider is being dragged. The slider only mutates
  // this value; the grid (`offsetSegments`) keeps using the *applied* `beatOffset`,
  // so looping stays locked to the stable old grid until the user confirms.
  draftBeatOffset: number
  loopCount: number | null // loop repetition limit; null = infinite
  learnedSegments: number[]
  /** Which loop flavour is active when looping is on. */
  loopMode: LoopMode
  /** Segment indices (1-based, matching `Segment.index`) ticked for multi-loop. */
  loopSegmentIds: number[]
  setSegment: (i: number) => void
  setPlaybackRate: (r: number) => void
  setMirror: (b: boolean) => void
  setBeatMirror: (b: boolean) => void
  setLoopSegment: (b: boolean) => void
  setABLoop: (v: ABLoop | null) => void
  setVoiceEnabled: (b: boolean) => void
  setBeatOffset: (n: number) => void
  /** Set only the draft offset (slider drag); does NOT re-cut the grid. */
  setDraftBeatOffset: (n: number) => void
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
  beatMirror: true,
  loopSegment: false,
  abLoop: null,
  voiceEnabled: false,
  beatOffset: 0,
  draftBeatOffset: 0,
  loopCount: null,
  learnedSegments: [],
  loopMode: 'single',
  loopSegmentIds: [],

  setSegment: (i) => set({ currentSegment: i }),
  setPlaybackRate: (r) => set({ playbackRate: r }),
  setMirror: (b) => set({ mirror: b }),
  // Beat overlay mirror is INDEPENDENT of the video mirror: it only flips the
  // count/dot overlay (BeatOverlay), not the video frame. Defaults to `true`
  // so the initial look matches the old single-switch behaviour (both flipped).
  setBeatMirror: (b) => set({ beatMirror: b }),
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
  // Confirming the offset applies it to the grid AND syncs the draft so the
  // slider reads the same value as the grid until the next drag begins.
  setBeatOffset: (n) => set({ beatOffset: n, draftBeatOffset: n }),
  // The slider only mutates the draft; the grid (`offsetSegments`) keeps using
  // the *applied* `beatOffset`, so looping stays locked to the stable old grid
  // until the user confirms (setBeatOffset).
  setDraftBeatOffset: (n) => set({ draftBeatOffset: n }),
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
      beatMirror: true,
      loopSegment: false,
      abLoop: null,
      voiceEnabled: false,
      beatOffset: 0,
      draftBeatOffset: 0,
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
