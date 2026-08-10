import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type MutableRefObject,
  type RefObject,
} from 'react'
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
    (segments.length
      ? currentTime < segments[0].startTime
        ? segments[0]
        : segments[segments.length - 1]
      : null)
  if (!seg) {
    return { activeSegment: 0, beatIndex: 0, crossed: false }
  }
  let beatIndex = 0
  for (let k = 0; k < seg.beats.length; k++) {
    if (seg.beats[k] <= currentTime) beatIndex = (seg.startBeat ?? 1) + k
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
 * A strict `[seg.startTime, seg.endTime)` loop chops off the transition on both
 * sides. The requested dance-practice window is:
 *
 *   previous phrase beat 8 -> target beats 1..8 -> next phrase beat 1
 *
 * Beat timestamps are the source of truth: the start is the previous phrase's
 * final beat and the end is the next phrase's second beat (the boundary after
 * its first beat has played). `beatDuration` is only a fallback for legacy or
 * partial grids. `segments` already carry any baked-in beat offset.
 *
 * The window is clamped at the timeline edges: the first segment never loops
 * before `t=0` and the last segment never loops past the media end. If
 * beat data is unavailable we degrade gracefully to the nearest safe boundary.
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
  if (safeBeat === 0) {
    return { loopStart: target.startTime, loopEnd: target.endTime }
  }
  const idx = segments.indexOf(target)
  const prevSeg = idx > 0 ? segments[idx - 1] : null
  const nextSeg = idx >= 0 && idx < segments.length - 1 ? segments[idx + 1] : null

  // Prefer real beat timestamps over a global average. This makes the seam
  // exactly: previous phrase beat 8 -> target beats 1..8 -> next phrase beat 1.
  // `loopEnd` is the boundary immediately AFTER that next first beat, normally
  // its second beat. The duration fallback covers partial/legacy beat grids.
  const previousBeat8 = prevSeg?.beats[prevSeg.beats.length - 1]
  const afterNextBeat1 = nextSeg?.beats[1]
  const loopStart = prevSeg
    ? Math.max(previousBeat8 ?? target.startTime - safeBeat, 0)
    : target.startTime
  const loopEnd = nextSeg
    ? afterNextBeat1 ?? Math.min(target.endTime + safeBeat, nextSeg.endTime)
    : target.endTime
  return { loopStart, loopEnd }
}

/** A contiguous run of selected segments treated as one loop block. */
export interface LoopBlock {
  segments: Segment[]
}

/** Group selected segment ids into contiguous blocks in timeline order. */
export function buildLoopBlocks(segments: Segment[], ids: number[]): LoopBlock[] {
  if (ids.length === 0 || segments.length === 0) return []
  const sorted = [...new Set(ids)].sort((a, b) => a - b)
  const blocks: LoopBlock[] = []
  let current: Segment[] = []
  for (const id of sorted) {
    const seg = segments.find((s) => s.index === id)
    if (!seg) continue
    if (current.length === 0 || seg.index === current[current.length - 1].index + 1) {
      current.push(seg)
    } else {
      blocks.push({ segments: current })
      current = [seg]
    }
  }
  if (current.length > 0) blocks.push({ segments: current })
  return blocks
}

/** Compute the one-beat padded window for a merged contiguous block. */
export function computePaddedLoopBoundsForBlock(
  block: LoopBlock,
  segments: Segment[],
  beatDuration: number,
): PaddedLoopBounds {
  const safeBeat =
    Number.isFinite(beatDuration) && beatDuration > 0 ? beatDuration : 0
  const startTime = block.segments[0].startTime
  const endTime = block.segments[block.segments.length - 1].endTime
  if (safeBeat === 0) return { loopStart: startTime, loopEnd: endTime }
  const firstSeg = segments[0]
  const lastSeg = segments[segments.length - 1]
  const hasLeadRoom = !!firstSeg && startTime > firstSeg.startTime + 1e-9
  const hasTrailRoom = !!lastSeg && endTime < lastSeg.endTime - 1e-9
  const firstIndex = segments.indexOf(block.segments[0])
  const lastIndex = segments.indexOf(block.segments[block.segments.length - 1])
  const previous = firstIndex > 0 ? segments[firstIndex - 1] : null
  const next = lastIndex >= 0 && lastIndex < segments.length - 1
    ? segments[lastIndex + 1]
    : null
  const previousBeat8 = previous?.beats[previous.beats.length - 1]
  const afterNextBeat1 = next?.beats[1]
  return {
    loopStart: hasLeadRoom
      ? Math.max(previousBeat8 ?? startTime - safeBeat, 0)
      : startTime,
    loopEnd: hasTrailRoom
      ? afterNextBeat1 ?? Math.min(endTime + safeBeat, next?.endTime ?? endTime + safeBeat)
      : endTime,
  }
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
  loopCount: number | null = null,
  /**
   * Loop flavour (Part 2). `'single'` loops the segment the playhead is in
   * (classic behaviour); `'multi'` cycles through the subset of segments the
   * user ticked in `loopSegmentIds`, each padded, wrapping the last back to the
   * first. Defaults to `'single'` so every existing caller is unaffected.
   */
  loopMode: 'single' | 'multi' = 'single',
  /** Segment indices (1-based, matching `Segment.index`) ticked for multi-loop. */
  loopSegmentIds: number[] = [],
  /**
   * Engine "active" flag. Compare-mode hides the player (`display:none`) but the
   * SAME <video> keeps playing side-by-side; when `false` the engine must NOT
   * issue any loop/AB seek+play, or it would fight the comparison playback — it
   * only keeps `prevTimeRef` fresh so re-activation never emits a phantom pulse.
   * Defaults to `true` so every existing caller is unaffected.
   */
  active: boolean = true,
  /** Imperative single-loop target used to make list clicks race-free. */
  forceLoopTargetRef?: MutableRefObject<number | null>,
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
  // A segment-list click writes `forceLoopTargetRef` immediately before it
  // seeks. Depending on the browser, rAF may consume that value before OR after
  // `seeked`. Keep a second copy until `seeked` settles so a frame landing a few
  // milliseconds before the requested boundary cannot re-lock 5 -> 4 (and then
  // cascade to 3 on the next padded restart).
  const forcedTargetAwaitingSeekRef = useRef<number | null>(null)
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
  const loopSeekLandingRef = useRef<number | null>(null)
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
  // Loop repetition limit. null = infinite. Read via ref inside `tick` so the
  // rAF loop always sees the latest value without re-binding the effect.
  const loopCountRef = useRef(loopCount)
  loopCountRef.current = loopCount
  // Counts completed loop-backs for the current loop run. Incremented on every
  // programmatic loop-back; when it reaches `loopCount` we stop seeking back so
  // the playhead continues past the loop boundary (exit & keep playing).
  const loopIterationRef = useRef(0)
  const loopExhaustedRef = useRef(false)
  // Tracks the previous-frame AB-enable state to detect its rising edge.
  const wasABEnabledRef = useRef(false)

  // ---- Multi-segment loop (Part 2) ------------------------------------------
  // Which loop flavour is active (mirrors the `loopMode` prop). When `'multi'`
  // and the selection is non-empty we cycle through the ticked segments; an
  // empty selection degrades to the classic single-segment loop.
  const loopModeRef = useRef(loopMode)
  loopModeRef.current = loopMode
  // The current multi-segment selection (mirrors the `loopSegmentIds` prop).
  const loopSegmentIdsRef = useRef(loopSegmentIds)
  loopSegmentIdsRef.current = loopSegmentIds
  // Whether the engine is "active" (mirrors `active`). Compare-mode shows the
  // shared <video> side-by-side and keeps playing; when inactive we must NOT
  // drive any loop/AB seek+play, or it would fight the comparison playback.
  const activeRef = useRef(active)
  activeRef.current = active
  // Contiguous selected segments are merged into blocks; separated blocks cycle.
  const loopTargetsRef = useRef<LoopBlock[]>([])
  // Cursor into `loopTargetsRef` for the block currently being looped.
  const loopCursorRef = useRef(0)
  // A multi-mode list click is an explicit block preference. It remains set
  // while looping is off, then is consumed when the selected blocks are built.
  const preferredMultiTargetRef = useRef<number | null>(null)
  // Serialised id list; lets the rAF loop cheaply detect a selection change and
  // rebuild `loopTargetsRef` + re-anchor the cursor without diffing each frame.
  const loopIdsKeyRef = useRef('')
  const loopConfigKey = `${loopMode}:${loopSegmentIds.join(',')}`
  const abConfigKey = abLoop
    ? `${abLoop.enabled}:${abLoop.aTime}:${abLoop.bTime}`
    : 'none'
  // Isolated guard flag for the custom A→B loop's OWN programmatic seek-back,
  // kept separate from `seekingForLoopRef` so the two loop kinds never
  // mis-classify each other's seeks (T3 hardening).
  const seekingForAbRef = useRef(false)
  const abSeekLandingRef = useRef<number | null>(null)

  useEffect(() => {
    const video = videoRef.current
    if (!video) return

    const anchorMultiTarget = (segmentIndex: number) => {
      const idsKey = loopSegmentIdsRef.current.join(',')
      if (idsKey !== loopIdsKeyRef.current) {
        loopIdsKeyRef.current = idsKey
        loopTargetsRef.current = buildLoopBlocks(
          segments,
          loopSegmentIdsRef.current,
        )
      }
      const index = loopTargetsRef.current.findIndex((block) =>
        block.segments.some((segment) => segment.index === segmentIndex),
      )
      if (index >= 0) loopCursorRef.current = index
      return index >= 0
    }

    const onSeeked = () => {
      const t = video.currentTime
      const forcedTarget =
        forceLoopTargetRef?.current ?? forcedTargetAwaitingSeekRef.current
      if (forcedTarget !== null) {
        // Explicit list/dot navigation is authoritative even when the decoded
        // frame lands just before the segment boundary (e.g. 17.375999 for a
        // requested 17.376). Never infer the target from that landing frame.
        if (loopModeRef.current === 'single') {
          loopTargetRef.current = forcedTarget
        } else {
          preferredMultiTargetRef.current = forcedTarget
          if (anchorMultiTarget(forcedTarget) && loopRef.current) {
            preferredMultiTargetRef.current = null
          }
        }
        loopIterationRef.current = 0
        loopExhaustedRef.current = false
        forcedTargetAwaitingSeekRef.current = null
        if (forceLoopTargetRef) forceLoopTargetRef.current = null
        prevTimeRef.current = t
      } else {
        const landingTolerance = Math.max(
          0.1,
          Math.min(0.35, beatDurationRef.current / 2),
        )
        const isLoopLanding =
          loopSeekLandingRef.current !== null &&
          Math.abs(t - loopSeekLandingRef.current) <= landingTolerance
        const isAbLanding =
          abSeekLandingRef.current !== null &&
          Math.abs(t - abSeekLandingRef.current) <= landingTolerance
        if (seekingForLoopRef.current || isLoopLanding) {
          // This is the loop's OWN programmatic loop-back (single OR multi). The
          // landing point may differ by tens of ms from the requested loopStart
          // (frame-level precision of a real <video>), which is now irrelevant
          // because we know WHO initiated the seek via the guard flag. Just reset
          // prevTime so the next frame does not re-detect the seam — do NOT
          // re-lock the target, otherwise we would latch onto the previous phrase
          // and cascade backward through the timeline. (multi: the new target was
          // already set synchronously inside `tick`.)
          seekingForLoopRef.current = false
          prevTimeRef.current = t
        } else if (seekingForAbRef.current || isAbLanding) {
          // This is the custom A→B loop's OWN programmatic seek-back. Isolated
          // from the single/multi loop guard so the two never mis-classify each
          // other's seeks (T3 hardening).
          seekingForAbRef.current = false
          prevTimeRef.current = t
        } else {
          // Genuine user seek (or initial navigation): re-lock the single / multi
          // loop target to whatever segment the playhead now sits in. For multi
          // mode we also re-anchor the cursor onto the selected segment containing
          // the new position (manual seek re-anchor). Using the same time for
          // prev/cur yields no crossed boundary, so no phantom pulse either.
          loopSeekLandingRef.current = null
          abSeekLandingRef.current = null
          prevTimeRef.current = t
          if (loopRef.current) {
            const loc = locateBeat(segments, t, t)
            loopTargetRef.current = loc.activeSegment || null
            preferredMultiTargetRef.current = null
            anchorMultiTarget(loc.activeSegment)
          }
          // Any genuine user reposition restarts the repetition count from zero.
          loopIterationRef.current = 0
          loopExhaustedRef.current = false
        }
      }
    }
    video.addEventListener('seeked', onSeeked)

    const tick = () => {
      const v = videoRef.current
      if (v) {
        const cur = v.currentTime
        const prev = prevTimeRef.current
        // Consume an explicit list-click target before any old loop clamp can
        // pull the playhead back to the previous segment.
        if (forceLoopTargetRef && forceLoopTargetRef.current !== null) {
          const forcedTarget = forceLoopTargetRef.current
          forcedTargetAwaitingSeekRef.current = forcedTarget
          if (loopModeRef.current === 'single') {
            loopTargetRef.current = forcedTarget
          } else {
            preferredMultiTargetRef.current = forcedTarget
            if (anchorMultiTarget(forcedTarget) && loopRef.current) {
              preferredMultiTargetRef.current = null
            }
          }
          loopIterationRef.current = 0
          loopExhaustedRef.current = false
          forceLoopTargetRef.current = null
        }
        const landingTolerance = Math.max(
          0.1,
          Math.min(0.35, beatDurationRef.current / 2),
        )
        // A real browser can occasionally omit or duplicate `seeked`. Retain
        // the expected landing briefly (to absorb duplicates), then clear the
        // in-flight guard once ordinary playback has moved safely away.
        if (
          loopSeekLandingRef.current !== null &&
          !v.seeking &&
          Math.abs(cur - loopSeekLandingRef.current) > landingTolerance
        ) {
          loopSeekLandingRef.current = null
          seekingForLoopRef.current = false
        }
        if (
          abSeekLandingRef.current !== null &&
          !v.seeking &&
          Math.abs(cur - abSeekLandingRef.current) > landingTolerance
        ) {
          abSeekLandingRef.current = null
          seekingForAbRef.current = false
        }
        // Compare-mode (inactive): the shared <video> is shown side-by-side and
        // keeps playing. Do NOT issue any loop/AB seek+play — just keep the
        // previous-frame time fresh so reactivating never spawns a phantom
        // pulse. Segment/beat display is skipped too (overlay hidden; the same
        // frame drives the comparison canvas). The rAF chain is re-scheduled
        // below before returning so the loop never dies.
        if (!activeRef.current) {
          prevTimeRef.current = cur
          rafRef.current = requestAnimationFrame(tick)
          return
        }
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
          // Multi-segment loop with a non-empty selection: the rAF target-refresh
          // (below) builds `loopTargetsRef` from `loopSegmentIds` and re-anchors
          // the cursor onto the segment the playhead is IN, so we leave
          // `loopTargetRef` null here and let that path seed it. Single loop (or
          // degraded multi) locks straight onto the current segment.
          if (!(loopModeRef.current === 'multi' && loopSegmentIdsRef.current.length > 0)) {
            loopTargetRef.current = realSegIndex
          }
          // A freshly enabled single-segment loop starts a new repetition count.
          loopIterationRef.current = 0
          loopExhaustedRef.current = false
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
          // Detect the rising edge of AB enable so a newly enabled AB loop
          // starts its repetition count from zero.
          const abEnabled = !!(ab && ab.enabled && ab.bTime > ab.aTime)
          if (abEnabled && !wasABEnabledRef.current) {
            loopIterationRef.current = 0
            loopExhaustedRef.current = false
          }
          wasABEnabledRef.current = abEnabled
          if (ab && ab.enabled && ab.bTime > ab.aTime) {
            // Custom A→B loop (priority over single-segment loop). When the
            // playhead crosses `bTime` we jump back to `aTime` and keep playing.
            // `newPrev` is seeded just before `aTime` so the next frame does not
            // re-detect `bTime` as crossed. The single-segment branch is skipped
            // entirely while AB is active, so the seek back into the earlier
            // segment can never re-trigger a padded loop and cascade backward.
            if (
              !loopExhaustedRef.current &&
              !v.seeking &&
              !seekingForAbRef.current &&
              cur + AB_LOOP_EPS >= ab.bTime
            ) {
              // Count this iteration; stop looping once the limit is reached.
              loopIterationRef.current += 1
              const reached =
                loopCountRef.current != null &&
                loopIterationRef.current >= loopCountRef.current
              if (!reached) {
                // Mark as programmatic so the resulting `seeked` is not mistaken
                // for a user drag (which would re-lock the single-segment target).
                // Uses the ISOLATED AB guard (seekingForAbRef) so the AB loop
                // never cross-talks with the single/multi loop guard (T3).
                seekingForAbRef.current = true
                abSeekLandingRef.current = ab.aTime
                v.currentTime = ab.aTime
                // A programmatic seek pauses the element internally; resume so the
                // loop keeps running instead of freezing on the seam.
                void v.play().catch(() => undefined)
                newPrev = ab.aTime - AB_LOOP_EPS
              } else {
                loopExhaustedRef.current = true
              }
              // reached: leave newPrev = cur so the playhead continues past
              // bTime -> the loop exits and the video keeps playing forward.
            }
          } else if (loopRef.current) {
            // Single- or multi-segment loop. Multi runs only when in multi mode
            // AND a non-empty selection exists; otherwise we fall back to the
            // existing single-segment loop so an empty multi selection degrades
            // gracefully to the familiar behaviour.
            //
            // Refresh the multi-segment target list when the selection changes
            // (cheap string-key diff). On change we rebuild the list and
            // re-anchor the cursor onto the segment the playhead currently sits
            // in, so an in-flight loop snaps to the new selection.
            const idsKey =
              loopModeRef.current === 'multi'
                ? loopSegmentIdsRef.current.join(',')
                : ''
            if (idsKey !== loopIdsKeyRef.current) {
              loopIdsKeyRef.current = idsKey
              loopTargetsRef.current =
                loopModeRef.current === 'multi'
                  ? buildLoopBlocks(segments, loopSegmentIdsRef.current)
                  : []
              if (loopCursorRef.current >= loopTargetsRef.current.length) {
                loopCursorRef.current = 0
              }
              const loc = locateBeat(segments, cur, prev)
              const preferredTarget = preferredMultiTargetRef.current
              const idx = loopTargetsRef.current.findIndex((block) =>
                block.segments.some(
                  (segment) =>
                    segment.index === (preferredTarget ?? loc.activeSegment),
                ),
              )
              if (idx >= 0) loopCursorRef.current = idx
              preferredMultiTargetRef.current = null
            }
            const multi =
              loopModeRef.current === 'multi' &&
              loopTargetsRef.current.length > 0

            if (multi) {
              const block = loopTargetsRef.current[loopCursorRef.current]
              if (block) {
                const bounds = computePaddedLoopBoundsForBlock(
                  block,
                  segments,
                  beatDurationRef.current,
                )
                if (
                  !loopExhaustedRef.current &&
                  !v.seeking &&
                  !seekingForLoopRef.current &&
                  cur + LOOP_EPS >= bounds.loopEnd
                ) {
                  loopIterationRef.current += 1
                  const reached =
                    loopCountRef.current != null &&
                    loopIterationRef.current >= loopCountRef.current
                  if (!reached) {
                    loopCursorRef.current =
                      (loopCursorRef.current + 1) % loopTargetsRef.current.length
                    const nextBlock = loopTargetsRef.current[loopCursorRef.current]
                    const nextBounds = nextBlock
                      ? computePaddedLoopBoundsForBlock(
                          nextBlock,
                          segments,
                          beatDurationRef.current,
                        )
                      : bounds
                    seekingForLoopRef.current = true
                    loopSeekLandingRef.current = nextBounds.loopStart
                    v.currentTime = nextBounds.loopStart
                    void v.play().catch(() => undefined)
                    newPrev = nextBounds.loopStart - 0.001
                  } else {
                    loopExhaustedRef.current = true
                  }
                }
              }
            } else {
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
                if (
                  !loopExhaustedRef.current &&
                  !v.seeking &&
                  !seekingForLoopRef.current &&
                  cur + LOOP_EPS >= bounds.loopEnd
                ) {
                  loopIterationRef.current += 1
                  const reached =
                    loopCountRef.current != null &&
                    loopIterationRef.current >= loopCountRef.current
                  if (!reached) {
                    seekingForLoopRef.current = true
                    loopSeekLandingRef.current = bounds.loopStart
                    v.currentTime = bounds.loopStart
                    void v.play().catch(() => undefined)
                    newPrev = bounds.loopStart - 0.001
                  } else {
                    loopExhaustedRef.current = true
                  }
                }
              }
            }
          } else {
            // Looping disabled -> drop the locked target and the multi state so
            // they re-acquire on the next enable.
            loopTargetRef.current = null
            loopTargetsRef.current = []
            loopCursorRef.current = 0
            loopIdsKeyRef.current = ''
            loopSeekLandingRef.current = null
            abSeekLandingRef.current = null
            seekingForLoopRef.current = false
            seekingForAbRef.current = false
            loopExhaustedRef.current = false
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

  // A new AB range starts a fresh run. The primitive key avoids treating the
  // equivalent object LessonPage creates on every render as a new range.
  useEffect(() => {
    loopIterationRef.current = 0
    loopExhaustedRef.current = false
    seekingForAbRef.current = false
    abSeekLandingRef.current = null
  }, [abConfigKey])

  // Re-arm the custom A→B loop when it is enabled but the playhead is already
  // past `bTime`: jump back to `aTime` so the loop starts cleanly instead of
  // waiting for the playhead to loop around the whole media (T3). The rising
  // edge iteration reset is handled inside `tick` via `wasABEnabledRef`. We use
  // the isolated `seekingForAbRef` guard so the resulting `seeked` is not
  // mistaken for a user drag (which would re-lock the single/multi loop target).
  // Skipped entirely while the engine is inactive (compare mode: the same
  // <video> is shown side-by-side and keeps playing — re-arming here would seek
  // + play and fight the comparison playback). Re-runs when `active` flips
  // false→true so the loop cleanly resumes after compare mode ends.
  useEffect(() => {
    const video = videoRef.current
    if (!video) return
    if (!activeRef.current) return
    const ab = abLoopRef.current
    if (
      !loopExhaustedRef.current &&
      ab &&
      ab.enabled &&
      ab.bTime > ab.aTime &&
      video.currentTime > ab.bTime
    ) {
      seekingForAbRef.current = true
      abSeekLandingRef.current = ab.aTime
      video.currentTime = ab.aTime
      void video.play().catch(() => undefined)
    }
  }, [abConfigKey, active, videoRef])

  // Reset the loop repetition counter whenever the limit changes (slider
  // drag / toggle) so a new count always starts counting from zero.
  useEffect(() => {
    loopIterationRef.current = 0
    loopExhaustedRef.current = false
  }, [loopCount])

  // Changing between single- and multi-segment looping starts a fresh loop
  // run. Without clearing both targets here, a segment selected in multi mode
  // can remain latched after switching back to single mode and pull playback
  // to the wrong phrase.
  useEffect(() => {
    loopIterationRef.current = 0
    loopTargetsRef.current = []
    loopCursorRef.current = 0
    loopIdsKeyRef.current = ''
    forcedTargetAwaitingSeekRef.current = null
    loopSeekLandingRef.current = null
    abSeekLandingRef.current = null
    seekingForLoopRef.current = false
    seekingForAbRef.current = false
    loopExhaustedRef.current = false
    if (loopMode !== 'multi') preferredMultiTargetRef.current = null

    const video = videoRef.current
    if (!loopRef.current || !video) {
      loopTargetRef.current = null
      return
    }
    if (loopMode === 'multi' && loopSegmentIds.length > 0) {
      loopTargetRef.current = null
      return
    }
    const loc = locateBeat(segments, video.currentTime, video.currentTime)
    loopTargetRef.current = loc.activeSegment || null
  }, [loopConfigKey, loopMode, loopSegmentIds.length, segments, videoRef])

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
