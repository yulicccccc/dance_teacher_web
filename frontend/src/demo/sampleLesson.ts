import type { AnalysisResult, Segment } from '../types/api'

/** Bundled same-origin sample used only by the no-upload product tour. */
export const DEMO_VIDEO_URL = '/demo.mp4'

const DEMO_DURATION = 28.8

/** Build a deterministic 8-count grid for the sample video. */
export function buildDemoResult(bpm = 100, firstBeatTime = 0): AnalysisResult {
  const safeBpm = Number.isFinite(bpm) && bpm > 0 ? bpm : 100
  const beatDuration = 60 / safeBpm
  const segmentDuration = beatDuration * 8
  const segments: Segment[] = []

  for (
    let start = firstBeatTime, index = 1;
    start + beatDuration * 7 < DEMO_DURATION;
    start += segmentDuration, index += 1
  ) {
    segments.push({
      index,
      startTime: Number(start.toFixed(3)),
      endTime: Number(Math.min(start + segmentDuration, DEMO_DURATION).toFixed(3)),
      type: 'dance',
      beats: Array.from({ length: 8 }, (_, beat) =>
        Number((start + beat * beatDuration).toFixed(3)),
      ),
    })
  }

  return {
    taskId: 'demo',
    videoName: '示例舞蹈（Demo）',
    bpm: safeBpm,
    confidence: 0.95,
    duration: DEMO_DURATION,
    createdAt: new Date().toISOString(),
    segments,
  }
}
