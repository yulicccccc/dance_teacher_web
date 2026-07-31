import type { Segment } from '../types/api'

/**
 * Video-comparison helpers for the "对照练习" feature.
 *
 * The comparison records the teacher video (left) and the learner's camera
 * (right) as ONE side-by-side canvas stream, so the recorded webm is already
 * composited — playback and download share the same file.
 */

/**
 * Pick which segment the comparison should record, given the learner's current
 * segment index. Falls back to the first segment when the index is missing.
 * Returns null only when there are no segments at all.
 */
export function resolveCompareSegment(
  segments: Segment[],
  currentSegment: number,
): Segment | null {
  if (!segments || segments.length === 0) return null
  return (
    segments.find((s) => s.index === currentSegment) ?? segments[0] ?? null
  )
}

/**
 * Whether the teacher playhead has reached (or passed) the segment end, so the
 * comparison recording should auto-stop. `eps` absorbs floating-point drift
 * across browsers.
 */
export function shouldAutoStop(
  currentTime: number,
  endTime: number,
  eps = 0.05,
): boolean {
  return currentTime >= endTime - eps
}

/**
 * Build a safe download filename for the composited comparison video, e.g.
 * `对比-小节3-my_lesson.webm`. Strips filesystem-unsafe characters.
 */
export function compareFileName(videoName: string, segmentIndex: number): string {
  const safe = (videoName || '对比')
    .replace(/[\\/:*?"<>|]+/g, '_')
    .replace(/\s+/g, '_')
    .slice(0, 60)
  return `对比-小节${segmentIndex}-${safe}.webm`
}

/**
 * Pick the best MediaRecorder mime type supported by this browser, or '' when
 * none of the candidates are supported.
 */
export function pickMimeType(): string {
  if (typeof MediaRecorder === 'undefined' || !MediaRecorder.isTypeSupported) {
    return ''
  }
  const candidates = [
    'video/webm;codecs=vp9,opus',
    'video/webm;codecs=vp8,opus',
    'video/webm;codecs=vp9',
    'video/webm;codecs=vp8',
    'video/webm',
  ]
  for (const c of candidates) {
    if (MediaRecorder.isTypeSupported(c)) return c
  }
  return ''
}
