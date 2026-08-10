import type { Segment } from '../types/api'

/** Robust per-beat interval derived only from adjacent beat timestamps. */
export function estimateBeatDuration(segments: Segment[]): number {
  const beats = segments.flatMap((segment) => segment.beats)
  const intervals: number[] = []
  for (let index = 1; index < beats.length; index++) {
    const interval = beats[index] - beats[index - 1]
    if (Number.isFinite(interval) && interval > 1e-6) intervals.push(interval)
  }
  if (intervals.length === 0) return 0
  intervals.sort((a, b) => a - b)
  const middle = Math.floor(intervals.length / 2)
  return intervals.length % 2 === 1
    ? intervals[middle]
    : (intervals[middle - 1] + intervals[middle]) / 2
}

/**
 * Re-cut the 8-beat phrase grid so that every phrase boundary follows the
 * manual `beatOffset` (measured in beats).
 *
 * ## Why this exists
 *
 * The backend returns `segments` aligned to *its own* beat grid. The "拍点计数偏移"
 * slider used to shift **only** the on-screen 1..8 count (inside `useBeatSync`):
 * `locateBeat(segments, cur - offsetSeconds, …)`. The phrase boundaries — the
 * left-rail list, the active-segment highlight, the single-segment loop target,
 * and the seek targets — all stayed pinned to the *original* grid. So after
 * nudging the offset to line the count up with the teacher, a single phrase
 * would still wrap `5→6→7→8→1→2→3→4` across the original boundary instead of
 * reading a clean `1→2→3→4→5→6→7→8`.
 *
 * This function re-derives the phrase grid from the flattened beat timeline so
 * that **every** consumer sees the same shifted grid. The offset is baked into
 * the segments themselves; `useBeatSync` then receives the already-shifted grid
 * and a `beatOffset` of `0` (applying the offset a second time would double it).
 *
 * ## The math
 *
 * Let `allBeats[j]` be the j-th beat (0-based) of the flattened timeline. The
 * displayed number of original beat `j` is `(j - beatOffset + 1)` [1-based]. We
 * want each new phrase to *start* on a beat whose displayed number is 1, i.e.
 * `(j - beatOffset) ≡ 0 (mod 8)` → `j ≡ beatOffset (mod 8)`. The smallest
 * non-negative such `j` tiles the timeline with clean 8-beat phrases:
 *
 *   startIndex = ((beatOffset % 8) + 8) % 8
 *
 * Examples (each beat = 0.5 s, uniform grid):
 *   offset =  0 → startIndex 0 → seg1 starts at allBeats[0]  = 0.0  (unchanged)
 *   offset = -4 → startIndex 4 → seg1 starts at allBeats[4]  = 2.0  (shifted right)
 *   offset = +2 → startIndex 2 → seg1 starts at allBeats[2]  = 1.0  (shifted right)
 *
 * ## Edge handling
 * - Empty input → `[]`.
 * - The leading partial phrase is kept from media time 0 to the first shifted
 *   downbeat. `startBeat` records its real first count (for example 5 when the
 *   visible fragment is beats 5..8).
 * - The trailing partial phrase is kept through the exact media duration.
 * - `beatOffset === 0` returns a grid equivalent to the input (same count,
 *   boundaries and beats) when the input already covers the whole media.
 *
 * Pure & side-effect free — same input always yields the same output — so it
 * can be unit-tested without React or a `<video>` element.
 */
export function resegmentSegments(
  segments: Segment[],
  beatOffset: number,
  duration?: number,
): Segment[] {
  // 1. Flatten every phrase's beats into one monotone time series.
  const allBeats: number[] = []
  for (const seg of segments) {
    for (const b of seg.beats) allBeats.push(b)
  }
  if (allBeats.length === 0) return []

  const originalEnd = segments.reduce(
    (max, segment) => Math.max(max, segment.endTime),
    0,
  )
  const hasDuration = Number.isFinite(duration) && (duration ?? 0) > 0
  const mediaEnd = hasDuration ? Number(duration) : originalEnd
  // A beat exactly at duration is a boundary with no playable frame after it,
  // not a one-beat zero-length phrase.
  const beats = hasDuration
    ? allBeats.filter((beat) => beat < mediaEnd - 1e-9)
    : allBeats
  if (beats.length === 0 || mediaEnd <= 0) return []

  // 2. First beat index of the shifted phrase grid.
  const startIndex = ((beatOffset % 8) + 8) % 8

  const result: Segment[] = []
  const append = (
    phraseBeats: number[],
    startTime: number,
    endTime: number,
    startBeat?: number,
  ) => {
    if (endTime <= startTime + 1e-9) return
    // Preserve the original phrase's semantic type for this beat group.
    const anchor = phraseBeats[0] ?? startTime
    const sourceSeg =
      segments.find((s) => s.startTime <= anchor && s.endTime > anchor) ??
      segments.find((s) => s.startTime <= anchor && s.endTime >= anchor) ??
      segments[0]
    result.push({
      index: result.length + 1,
      startTime,
      endTime,
      type: sourceSeg ? sourceSeg.type : 'dance',
      beats: phraseBeats,
      ...(startBeat && startBeat !== 1 ? { startBeat } : {}),
    })
  }

  // 3. Keep the fragment before the first shifted downbeat. For startIndex=4,
  // the visible original beats 0..3 are counts 5..8 of the previous phrase.
  if (startIndex > 0) {
    const partialBeats = beats.slice(0, Math.min(startIndex, beats.length))
    const partialEnd = startIndex < beats.length ? beats[startIndex] : mediaEnd
    append(partialBeats, 0, partialEnd, 9 - startIndex)
  }

  // 4. Cut complete phrases from the shifted downbeat and keep the final short
  // phrase through mediaEnd. With no offset the first phrase also owns any
  // no-beat pre-roll between 0 and the first detected beat.
  for (let base = startIndex; base < beats.length; base += 8) {
    const phraseBeats = beats.slice(base, base + 8)
    const startTime = base === 0 ? 0 : beats[base]
    const endTime = base + 8 < beats.length ? beats[base + 8] : mediaEnd
    append(phraseBeats, startTime, endTime)
  }
  return result
}

/**
 * Result of {@link findBeatAt}: the beat whose timestamp is the most recent one
 * at or before `time` (inclusive), plus convenience indices for display.
 */
export interface BeatHit {
  /** 1-based segment index the beat belongs to (0 if no beat qualifies). */
  segIndex: number
  /** 1-based beat number within its segment. */
  beatInSeg: number
  /** Timestamp (seconds) of the matched beat — the loop anchor. */
  beatTime: number
  /** 1-based global beat ordinal across the whole (flattened) timeline. */
  globalBeat: number
}

/**
 * Locate the beat that is the nearest one at or before `time` on the real
 * timeline. Used to anchor the custom A→B loop on a beat rather than an
 * arbitrary sub-beat position (so the loop seam lines up with the music).
 *
 * Scans every segment's beats in order; because segment start times and the
 * beats within a segment are both monotonically increasing, the LAST beat
 * whose timestamp `<= time` is the anchor. If `time` falls before the very
 * first beat (e.g. in the leading gap of an offset grid) we fall back to the
 * first beat of the first segment so a loop anchor always exists.
 *
 * Pure and side-effect free — unit-testable without a `<video>` element.
 */
export function findBeatAt(segments: Segment[], time: number): BeatHit | null {
  if (segments.length === 0) return null
  let found: BeatHit | null = null
  let global = 0
  for (const seg of segments) {
    for (let k = 0; k < seg.beats.length; k++) {
      global += 1
      const bt = seg.beats[k]
      if (bt <= time) {
        found = {
          segIndex: seg.index,
          beatInSeg: (seg.startBeat ?? 1) + k,
          beatTime: bt,
          globalBeat: global,
        }
      }
    }
  }
  if (!found) {
    // Leading gap before the first beat: anchor on the first beat anyway so
    // the caller always gets a real beat to loop on.
    const first = segments[0]
    found = {
      segIndex: first.index,
      beatInSeg: first.startBeat ?? 1,
      beatTime: first.beats[0],
      globalBeat: 1,
    }
  }
  return found
}
