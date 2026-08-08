import { gridOnlyDetect } from '../audio/gridOnlyDetector'
import { beatDetectionDetect } from '../audio/beatDetectionDetector'
import type { DetectRequest, DetectResponse } from './protocol'

const ctx = self as unknown as Worker

/**
 * Detect on the decoded mono PCM:
 *   1. Try the precise `beat-detection` tracker (T03) first — accurate BPM
 *      + dynamically tracked beat grid, no wasm, runs in this worker.
 *   2. Fall back to the zero-dependency MVP grid detector if the precise
 *      path returns null (empty/undefined input) or throws. This guarantees
 *      the UI always gets a usable beat grid.
 */
function runDetection(req: DetectRequest) {
  const audio = { pcm: req.pcm, sampleRate: req.sampleRate, duration: req.duration }
  const precise = beatDetectionDetect(audio)
  if (precise) return precise
  return gridOnlyDetect(audio)
}

self.addEventListener('message', (e: MessageEvent<DetectRequest>) => {
  const { type, taskId, pcm, sampleRate, duration } = e.data
  if (type !== 'detect') return
  try {
    const result = runDetection({ type, taskId, pcm, sampleRate, duration })
    const msg: DetectResponse = { type: 'result', taskId, result }
    ctx.postMessage(msg)
  } catch (err) {
    // Last-ditch fallback so a single detector failure never breaks UX.
    try {
      const result = gridOnlyDetect({ pcm, sampleRate, duration })
      const msg: DetectResponse = { type: 'result', taskId, result }
      ctx.postMessage(msg)
      return
    } catch {
      /* fall through to error */
    }
    const msg: DetectResponse = {
      type: 'error',
      taskId,
      message: err instanceof Error ? err.message : String(err),
    }
    ctx.postMessage(msg)
  }
})
