import type { DetectRequest, DetectResponse } from './protocol'
import type { DecodedAudio, DetectResult } from '../types/local'

let worker: Worker | null = null

function getWorker(): Worker {
  if (!worker) {
    worker = new Worker(new URL('./beat.worker.ts', import.meta.url), {
      type: 'module',
    })
  }
  return worker
}

/**
 * Run the grid-only detector off the main thread so the UI stays responsive
 * while a multi-minute clip is analysed. A single worker is reused across
 * calls; each request carries a unique `taskId` to match the response.
 */
export function detectBeats(audio: DecodedAudio): Promise<DetectResult> {
  return new Promise<DetectResult>((resolve, reject) => {
    const taskId = `w${Math.random().toString(36).slice(2)}`
    const w = getWorker()

    const onMessage = (e: MessageEvent<DetectResponse>) => {
      const data = e.data
      if (data.taskId !== taskId) return
      cleanup()
      if (data.type === 'result') resolve(data.result)
      else reject(new Error(data.message))
    }
    const onError = (e: ErrorEvent) => {
      cleanup()
      reject(e.error instanceof Error ? e.error : new Error(e.message))
    }
    const cleanup = () => {
      w.removeEventListener('message', onMessage)
      w.removeEventListener('error', onError)
    }

    w.addEventListener('message', onMessage)
    w.addEventListener('error', onError)

    const req: DetectRequest = {
      type: 'detect',
      taskId,
      pcm: audio.pcm,
      sampleRate: audio.sampleRate,
      duration: audio.duration,
    }
    w.postMessage(req)
  })
}
