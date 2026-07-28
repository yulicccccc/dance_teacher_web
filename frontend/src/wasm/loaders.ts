import { FFmpeg } from '@ffmpeg/ffmpeg'
import { toBlobURL } from '@ffmpeg/util'
import { isMultithread } from '../analysis/crossOrigin'
import type { EssentiaInstance } from '../types/essentia'

/**
 * Browser-side engine loaders for the pure-frontend analysis pipeline.
 *
 * - ffmpeg.wasm is used to extract the audio track from the uploaded video.
 * - essentia.js (WASM) runs `RhythmExtractor2013` for BPM / beats / confidence.
 *
 * Both engines are loaded lazily (only when an analysis actually starts),
 * cached as singletons (so re-analysing another video reuses the warm instance),
 * and — for ffmpeg — choose the multi-thread core when the page is
 * cross-origin isolated (SharedArrayBuffer available), otherwise the
 * single-thread core.
 */

const USE_MT = isMultithread()

const ESSENTIA_WASM_URL = '/wasm/essentia/essentia-wasm.web.wasm'
const ESSENTIA_GLUE_URL = '/wasm/essentia/essentia-wasm.web.js'

let ffmpegPromise: Promise<FFmpeg> | null = null
let essentiaPromise: Promise<EssentiaInstance> | null = null

/** Phase tag passed to {@link LoadProgress} so callers can label the bar. */
export type LoadPhase = 'ffmpeg' | 'essentia'

export type LoadProgress = (phase: LoadPhase, ratio: number) => void

/** Expose which ffmpeg core variant will be used (for diagnostics / UI). */
export function ffmpegUsesMultithread(): boolean {
  return USE_MT
}

/**
 * Load (and cache) the ffmpeg.wasm instance.
 *
 * @param onProgress Optional callback receiving load progress in [0, 1].
 */
export function loadFfmpeg(onProgress?: LoadProgress): Promise<FFmpeg> {
  if (ffmpegPromise) return ffmpegPromise

  ffmpegPromise = (async () => {
    const ffmpeg = new FFmpeg()
    ffmpeg.on('progress', (e: { progress: number }) => {
      const ratio = Number.isFinite(e.progress)
        ? Math.min(1, Math.max(0, e.progress))
        : 0
      onProgress?.('ffmpeg', ratio)
    })

    if (USE_MT) {
      const base = '/wasm/ffmpeg/core-mt'
      await ffmpeg.load({
        coreURL: await toBlobURL(`${base}/ffmpeg-core.js`, 'text/javascript'),
        wasmURL: await toBlobURL(`${base}/ffmpeg-core.wasm`, 'application/wasm'),
        workerURL: await toBlobURL(`${base}/ffmpeg-core.worker.js`, 'text/javascript'),
      })
    } else {
      const base = '/wasm/ffmpeg/core'
      await ffmpeg.load({
        coreURL: await toBlobURL(`${base}/ffmpeg-core.js`, 'text/javascript'),
        wasmURL: await toBlobURL(`${base}/ffmpeg-core.wasm`, 'application/wasm'),
      })
    }

    onProgress?.('ffmpeg', 1)
    return ffmpeg
  })()

  // Reset the cache on failure so a retry can re-load cleanly.
  ffmpegPromise.catch(() => {
    ffmpegPromise = null
  })
  return ffmpegPromise
}

/**
 * Poll until `predicate()` is truthy or the timeout elapses. Used to wait for
 * the essentia WASM module to finish initializing before we call algorithms.
 */
function waitFor(predicate: () => boolean, timeoutMs = 30000): Promise<void> {
  return new Promise((resolve, reject) => {
    if (predicate()) return resolve()
    const start = Date.now()
    const timer = setInterval(() => {
      if (predicate()) {
        clearInterval(timer)
        resolve()
      } else if (Date.now() - start > timeoutMs) {
        clearInterval(timer)
        reject(new Error('essentia.js 初始化超时'))
      }
    }, 50)
  })
}

/**
 * Load (and cache) the essentia.js WASM instance.
 *
 * The Emscripten glue is fetched from the self-hosted static path
 * (`/wasm/essentia/essentia.wasm.js`) so it stays same-origin under COEP, and
 * the `.wasm` binary is resolved via `locateFile` to the same directory. We
 * pass the factory to `new Essentia(...)` exactly as the official essentia.js
 * usage shows, then wait until `RhythmExtractor2013` is actually available
 * (some builds finish module init asynchronously) before resolving.
 */
export function loadEssentia(onProgress?: LoadProgress): Promise<EssentiaInstance> {
  if (essentiaPromise) return essentiaPromise

  essentiaPromise = (async () => {
    const { Essentia }: { Essentia: EssentiaInstance } = await import('essentia.js')
    const glue: { default: (opts?: Record<string, unknown>) => unknown } = await import(
      /* @vite-ignore */ ESSENTIA_GLUE_URL
    )
    const factory = glue.default
    const essentia = new Essentia((opts: Record<string, unknown>) =>
      factory({
        ...opts,
        locateFile: (path: string) =>
          path === 'essentia-wasm.web.wasm' ? ESSENTIA_WASM_URL : path,
      }),
    )
    await waitFor(() => typeof (essentia as unknown as {
      RhythmExtractor2013?: unknown
    }).RhythmExtractor2013 === 'function')
    onProgress?.('essentia', 1)
    return essentia
  })()

  essentiaPromise.catch(() => {
    essentiaPromise = null
  })
  return essentiaPromise
}

/** Reset cached engines — primarily for tests. */
export function resetLoaders(): void {
  ffmpegPromise = null
  essentiaPromise = null
}
