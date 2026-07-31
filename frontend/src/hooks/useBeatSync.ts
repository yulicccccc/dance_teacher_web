import { useCallback, useEffect, useRef, useState, type RefObject } from 'react'
import type { Segment, ABLoop } from '../types/api'

interface SyncResult {
  beatIndex: number // 1..8 (0 = none yet)
  pulse: boolean // transient flag for the beat pulse animation
  activeSegment: number // 1-based segment currently playing
  /** Seek to the adjacent beat (dir=1 next, dir=-1 previous) and pause there. */
  stepBeat: (dir: 1 | -1) => void
}

export interface BeatLocator {
  activeSegment: number // 1-based segment index, 0 if none
  beatIndex: number // 1..8 (0 = none yet)
  crossed: boolean // a beat boundary was crossed this frame -> pulse
}

/**
 * Pure positioning core (system design §1.3). Given the current playback time
 * and the previous frame's time, locate the active 8-beat segment, the current
 * beat number (1..8), and whether a beat boundary was just crossed (pulse).
 *
 * Kept side-effect free so it can be unit-tested without a <video> element;
 * `useBeatSync` delegates its per-frame math to this function.
 */
export function locateBeat(
  segments: Segment[],
  currentTime: number,
  prevTime: number,
): BeatLocator {
  const seg =
    segments.find((s) => currentTime >= s.startTime && currentTime < s.endTime) ??
    (segments.length ? segments[segments.length - 1] : null)
  if (!seg) {
    return { activeSegment: 0, beatIndex: 0, crossed: false }
  }
  let beatIndex = 0
  for (let k = 0; k < seg.beats.length; k++) {
    if (seg.beats[k] <= currentTime) beatIndex = k + 1
  }
  let crossed = false
  for (const bt of seg.beats) {
    if (prevTime < bt && bt <= currentTime) crossed = true
  }
  return { activeSegment: seg.index, beatIndex, crossed }
}

/**
 * Given the playback head position on the previous frame (`prevTime`) and the
 * current frame (`curTime`), return the segment whose **END** was crossed
 * during this frame — i.e. the segment we just finished playing.
 *
 * This is the segment that a single-segment loop must restart. It is computed
 * from the *crossed boundary* (`prevTime < endTime - EPS && endTime <= curTime`),
 * NOT by locating the segment that contains `curTime`: by the time `curTime`
 * has passed a segment's `endTime` it has already entered the *next* segment,
 * so a locate-by-`curTime` would never see that boundary — the loop would
 * silently skip every interior segment and only ever catch the last one via
 * the end-of-media fallback. (Bug A.)
 *
 * The lower bound uses a small epsilon (`EPS`) so that, immediately after a
 * loop restart seeks back to `seg.startTime` (which is also the PREVIOUS
 * segment's `endTime`), the next frame — whose `prevTime` is `seg.startTime`
 * minus a hair — does NOT re-detect that previous boundary and cascade
 * backward through the segments. The upper bound is inclusive so a frame that
 * lands exactly on the boundary still triggers the loop.
 *
 * Pure and side-effect free so it can be unit-tested without a <video> element.
 */
const LOOP_EPS = 1e-3
/** Epsilon for the custom A→B loop boundary detection (same order as LOOP_EPS). */
const AB_LOOP_EPS = 1e-3
export function computeLoopSegment(
  segments: Segment[],
  prevTime: number,
  curTime: number,
): Segment | null {
  if (segments.length === 0) return null
  return (
    segments.find((s) => prevTime < s.endTime - LOOP_EPS && s.endTime <= curTime) ?? null
  )
}

/**
 * Result of {@link computePaddedLoopBounds}: the padded play window for a
 * single-segment loop that includes one beat of lead-in and one beat of
 * trail-out so dance moves glued to the bar lines stay connected at the seam.
 */
export interface PaddedLoopBounds {
  loopStart: number
  loopEnd: number
}

/**
 * Compute the padded loop window for a single-segment loop.
 *
 * A strict `[seg.startTime, seg.endTime)` loop chops off the leading beat of
 * the *previous* phrase and the trailing beat of the *next* one, so the dance
 * action never lines up across the loop seam. We extend the window by one beat
 * on BOTH sides:
 *
 *   loopStart = prevSeg ? Math.max(seg.startTime - beatDuration, 0) : seg.startTime
 *   loopEnd   = nextSeg ? seg.endTime + beatDuration               : seg.endTime
 *
 * `segments` already carry the baked-in `beatOffset` (see `offsetSegments`),
 * so no extra offset math is needed here — `beatDuration` is used directly.
 *
 * The window is clamped at the timeline edges: the first segment never loops
 * before `t=0` and the last segment never loops past the media end. If
 * `beatDuration` is not a positive finite number we degrade gracefully to the
 * raw `[startTime, endTime)` window.
 *
 * Pure and side-effect free so it can be unit-tested without a `<video>`.
 */
export function computePaddedLoopBounds(
  target: Segment,
  segments: Segment[],
  beatDuration: number,
): PaddedLoopBounds {
  const safeBeat =
    Number.isFinite(beatDuration) && beatDuration > 0 ? beatDuration : 0
  const idx = segments.indexOf(target)
  const prevSeg = idx > 0 ? segments[idx - 1] : null
  const nextSeg = idx >= 0 && idx < segments.length - 1 ? segments[idx + 1] : null

  const loopStart = prevSeg
    ? Math.max(target.startTime - safeBeat, 0)
    : target.startTime
  const loopEnd = nextSeg ? target.endTime + safeBeat : target.endTime
  return { loopStart, loopEnd }
}

/**
 * Core beat-sync engine (system design §1.3).
 *
 * Drives a `requestAnimationFrame` loop that reads `video.currentTime` every
 * frame (~16ms, far finer than the `timeupdate` event) and:
 *   1. locates the active segment  -> `startTime <= t < endTime`
 *   2. counts the current beat     -> last beat <= t
 *   3. fires a pulse when a beat is *crossed* (prevTime < beatT <= cur)
 *   4. clamps back to segment start when looping and t >= endTime
 *
 * Slow-motion is naturally handled: `currentTime` still advances in real time,
 * so the beat timestamps (also real-time) stay aligned; pulses just slow down
 * with the playback. A `seeked` listener resets `prevTime` so dragging the
 * scrubber never produces phantom pulses.
 */
export function useBeatSync(
  videoRef: RefObject<HTMLVideoElement>,
  segments: Segment[],
  loopSegment: boolean,
  beatOffset: number,
  beatDuration: number,
  onSegmentChange?: (segmentIndex: number) => void,
  abLoop: ABLoop | null = null,
): SyncResult {
  const [beatIndex, setBeatIndex] = useState(0)
  const [pulse, setPulse] = useState(false)
  const [activeSegment, setActiveSegment] = useState(1)

  const beatIndexRef = useRef(0)
  const activeSegRef = useRef(1)
  const prevTimeRef = useRef(0)
  const pulseTimer = useRef<number | null>(null)
  const rafRef = useRef<number | null>(null)
  const loopRef = useRef(loopSegment)
  loopRef.current = loopSegment
  // Index of the segment currently being padded-looped. Once a single-segment
  // loop locks onto its target we only ever watch THAT segment's padded
  // loopEnd; we never scan other segments, so seeking back into the previous
  // phrase (because loopStart includes a one-beat lead-in that lands inside
  // the previous segment) cannot re-trigger a loop and cascade backward.
  // Cleared whenever looping is disabled so it re-acquires on the next enable.
  const loopTargetRef = useRef<number | null>(null)
  // Guard flag set immediately BEFORE the single-segment loop performs its OWN
  // programmatic loop-back seek (`video.currentTime = bounds.loopStart`). The
  // `seeked` listener reads it to tell the loop's own loop-back apart from a
  // genuine USER seek (drag/scrub), so the target is NOT re-locked into the
  // previous phrase (which would cascade backward through the timeline).
  // We use a guard flag instead of comparing the seek *landing point* to the
  // requested `loopStart`, because a real <video> reports `currentTime` with
  // frame-level precision (±16–33ms at 30fps) that routinely exceeds any fixed
  // tolerance — the old 10ms position comparison misread loop-backs as user
  // jumps and cascaded backward.
  const seekingForLoopRef = useRef(false)
  // Tracks the previous-frame value of `loopRef` so we can detect the *rising
  // edge* of "single-segment loop" enable. On that edge we immediately lock
  // `loopTargetRef` to the segment the playhead is currently IN (from
  // `locateBeat` against the real time), instead of waiting for the next
  // segment boundary to be crossed. Without this, enabling loop mid-segment
  // would often lock onto the NEXT segment — the boundary-crossing heuristic
  // only fires once a boundary is actually crossed, which may be the next
  // bar's end, so the loop would occasionally target the wrong section.
  const wasLoopRef = useRef(false)
  const beatOffsetRef = useRef(beatOffset)
  beatOffsetRef.current = beatOffset
  // Keep the per-beat duration in a ref updated every render. The rAF loop's
  // `tick` closes over `beatDuration` from the effect, whose deps are
  // [segments, videoRef]; mirroring it into a ref guarantees the offset math
  // always uses the freshest (and finite) value, never a stale closure copy.
  // (Bug B hardening.)
  const beatDurationRef = useRef(beatDuration)
  beatDurationRef.current = Number.isFinite(beatDuration) && beatDuration > 0 ? beatDuration : 0
  const onSegRef = useRef(onSegmentChange)
  onSegRef.current = onSegmentChange
  // Custom A→B loop config. Read via ref inside `tick` so the rAF loop always
  // sees the latest value without re-binding the effect (deps stay
  // [segments, videoRef], matching loopRef/beatOffsetRef). When enabled, the
  // AB branch takes priority over the single-segment loop (invariant:
  // abLoop > loopSegment), so seeking back to `aTime` can never re-trigger the
  // padded single-segment loop and cascade backward.
  const abLoopRef = useRef<ABLoop | null>(abLoop)
  abLoopRef.current = abLoop

  useEffect(() => {
    const video = videoRef.current
    if (!video) return

    const onSeeked = () => {
      const t = video.currentTime
      if (seekingForLoopRef.current) {
        // This is the loop's OWN programmatic loop-back. The landing point may
        // differ by tens of ms from the requested `loopStart` (frame-level
        // precision of a real <video>), which is now irrelevant because we know
        // WHO initiated the seek via the guard flag. Just reset prevTime so the
        // next frame does not re-detect the seam — do NOT re-lock the target,
        // otherwise we would latch onto the previous phrase and cascade
        // backward through the timeline.
        seekingForLoopRef.current = false
        prevTimeRef.current = t
      } else {
        // Genuine user seek (or initial navigation): re-lock the single-segment
        // loop target to whatever segment the playhead now sits in. Using the
        // same time for prev/cur yields no crossed boundary, so no phantom
        // pulse either.
        prevTimeRef.current = t
        if (loopRef.current) {
          const loc = locateBeat(segments, t, t)
          loopTargetRef.current = loc.activeSegment || null
        }
      }
    }
    video.addEventListener('seeked', onSeeked)

    const tick = () => {
      const v = videoRef.current
      if (v) {
        const cur = v.currentTime
        const prev = prevTimeRef.current
        const offsetSeconds = beatDurationRef.current > 0 ? beatOffsetRef.current * beatDurationRef.current : 0

        // The active-segment highlight and the single-segment loop clamp are
        // driven by the REAL playback time. They are intentionally NOT offset,
        // so the loop boundary stays locked to the actual video position.
        const { activeSegment: realSegIndex } = locateBeat(segments, cur, prev)
        const seg = segments.find((s) => s.index === realSegIndex) ?? null

        // 单节循环上升沿：立即锁定「播放头当前所在小节」，避免锁定到下一节。
        // On the rising edge of loop enable we lock the target right away to
        // the segment the playhead currently sits in, rather than waiting for
        // the next boundary crossing (which would risk locking the NEXT bar).
        if (loopRef.current && !wasLoopRef.current && seg) {
          loopTargetRef.current = realSegIndex
        }
        // Always mirror the latest loop state every tick so we can detect the
        // next rising edge even when `seg` is null on this frame.
        wasLoopRef.current = loopRef.current

        // The beat grid and pulse window are shifted by the manual offset,
        // which is now expressed in BEATS and converted to seconds internally
        // (offsetSeconds) so the 1..8 count can be nudged to line up with the
        // dance action. Shifting both `cur` and `prev` by the same amount keeps
        // beat-crossing detection consistent.
        const { beatIndex: bi, crossed } = locateBeat(
          segments,
          cur - offsetSeconds,
          prev - offsetSeconds,
        )

        if (seg) {
          if (realSegIndex !== activeSegRef.current) {
            activeSegRef.current = realSegIndex
            setActiveSegment(realSegIndex)
            onSegRef.current?.(realSegIndex)
          }

          if (bi !== beatIndexRef.current) {
            beatIndexRef.current = bi
            setBeatIndex(bi)
          }

          // pulse on beat crossing
          if (crossed) {
            setPulse(true)
            if (pulseTimer.current) window.clearTimeout(pulseTimer.current)
            pulseTimer.current = window.setTimeout(() => setPulse(false), 250)
          }

          // Single-segment loop clamp with a one-beat lead-in / trail-out pad.
          // The target segment is chosen by the crossed-boundary heuristic
          // (Bug A semantics) the first time we cross one of its ends; after
          // that the target is locked so only ITS padded window is watched —
          // this is what stops the lead-in seek (into the previous phrase) from
          // re-triggering a loop and cascading backward.
          let newPrev = cur
          const ab = abLoopRef.current
          if (ab && ab.enabled && ab.bTime > ab.aTime) {
            // Custom A→B loop (priority over single-segment loop). When the
            // playhead crosses `bTime` we jump back to `aTime` and keep playing.
            // `newPrev` is seeded just before `aTime` so the next frame does not
            // re-detect `bTime` as crossed. The single-segment branch is skipped
            // entirely while AB is active, so the seek back into the earlier
            // segment can never re-trigger a padded loop and cascade backward.
            if (prev < ab.bTime - AB_LOOP_EPS && ab.bTime <= cur) {
              // Mark as programmatic so the resulting `seeked` is not mistaken
              // for a user drag (which would re-lock the single-segment target).
              seekingForLoopRef.current = true
              v.currentTime = ab.aTime
              // A programmatic seek pauses the element internally; resume so the
              // loop keeps running instead of freezing on the seam.
              void v.play().catch(() => undefined)
              newPrev = ab.aTime - AB_LOOP_EPS
            }
          } else           if (loopRef.current) {
            if (loopTargetRef.current === null) {
              const leftSeg = computeLoopSegment(segments, prev, cur)
              if (leftSeg) loopTargetRef.current = leftSeg.index
            }
            const target =
              segments.find((s) => s.index === loopTargetRef.current) ?? null
            if (target) {
              const bounds = computePaddedLoopBounds(
                target,
                segments,
                beatDurationRef.current,
              )
              // Restart only after the playhead has actually played THROUGH the
              // padded loopEnd (which includes the trailing one-beat buffer),
              // so the extra beat before the seam is truly heard/seen.
              if (prev < bounds.loopEnd - LOOP_EPS && bounds.loopEnd <= cur) {
                // Flag that the upcoming seek is the loop's OWN programmatic
                // loop-back, so the `seeked` listener recognises it (and does
                // NOT re-lock the target into the previous phrase's lead-in,
                // which would cascade backward). We use a guard flag rather than
                // comparing the seek landing point to `loopStart`, because real
                // <video> currentTime precision (±16–33ms) dwarfs any fixed tol.
                seekingForLoopRef.current = true
                v.currentTime = bounds.loopStart
                // A programmatic seek triggers an internal pause on <video>;
                // resume playback so the loop keeps running instead of freezing.
                void v.play().catch(() => undefined)
                newPrev = bounds.loopStart - 0.001
              }
            }
          } else {
            // Looping disabled -> drop the locked target so it re-acquires on
            // the next enable.
            loopTargetRef.current = null
          }
          prevTimeRef.current = newPrev
        } else {
          prevTimeRef.current = cur
        }
      }
      rafRef.current = requestAnimationFrame(tick)
    }
    rafRef.current = requestAnimationFrame(tick)

    return () => {
      video.removeEventListener('seeked', onSeeked)
      if (rafRef.current) cancelAnimationFrame(rafRef.current)
      if (pulseTimer.current) window.clearTimeout(pulseTimer.current)
    }
  }, [segments, videoRef])

  /**
   * Jump the playhead to the adjacent beat timestamp and freeze there.
   *
   * dir = 1  → the next beat strictly after the current time (clamped to the
   *            last beat when already past the end of the grid).
   * dir = -1 → the previous beat strictly before the current time (clamped to
   *            the first beat when already at/ahead of the grid start).
   *
   * Intentionally does NOT touch `seekingForLoopRef`: the resulting `seeked`
   * event is treated by `onSeeked` as a genuine user seek, which re-locks the
   * single-segment loop target onto the new beat's segment — the same
   * (desired) behavior as dragging the scrubber.
   */
  const stepBeat = useCallback(
    (dir: 1 | -1) => {
      const v = videoRef.current
      if (!v || segments.length === 0) return
      // Global ascending list of beat timestamps across all segments.
      const beats = segments.flatMap((s) => s.beats)
      if (beats.length === 0) return
      const t = v.currentTime
      const EPS = 1e-3
      let target: number
      if (dir === 1) {
        // Next beat; clamp to the last beat once past the end of the grid.
        target = beats.find((b) => b > t + EPS) ?? beats[beats.length - 1]
      } else {
        // Previous beat; clamp to the first beat at/ahead of the grid start.
        const rev = [...beats].reverse().find((b) => b < t - EPS)
        target = rev ?? beats[0]
      }
      v.currentTime = target
      v.pause()
    },
    [segments, videoRef],
  )

  return { beatIndex, pulse, activeSegment, stepBeat }
}
