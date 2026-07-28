import type { FFmpeg } from '@ffmpeg/ffmpeg'
import { loadEssentia, loadFfmpeg } from '../wasm/loaders'
import { extractAudio } from '../audio/extractAudio'
import { detectBeats } from '../audio/beatDetect'
import { segmentPhrases, recompute } from '../audio/segmentPhrases'
import type { AnalysisResult, RecomputeMode } from '../types/api'
import type { AnalyzePhase } from '../store/analysisStore'

export type { AnalyzePhase }

/** Confidence below this flags the segmentation as low and offers recompute. */
const LOW_CONFIDENCE = 0.6

/**
 * Error thrown at any pipeline stage. Carries the `phase` it failed in and a
 * stable `code` so the UI can show targeted messaging and the retry path knows
 * what to do.
 */
export class AnalysisError extends Error {
  phase: AnalyzePhase
  code: string
  constructor(phase: AnalyzePhase, code: string, message: string) {
    super(message)
    this.name = 'AnalysisError'
    this.phase = phase
    this.code = code
  }
}

export interface AnalyzeCallbacks {
  onPhase?: (phase: AnalyzePhase) => void
  onProgress?: (phase: AnalyzePhase, progress: number) => void
}

export interface AnalyzeOptions {
  /** Stable id for the result (defaults to a hash of the file). */
  videoId?: string
  videoName?: string
  signal?: AbortSignal
  callbacks?: AnalyzeCallbacks
}

export interface AnalyzeOutcome {
  result: AnalysisResult
  /** Release the ffmpeg worker / WASM memory held by this run. */
  cleanup: () => void
}

function computeVideoId(file: File): string {
  const raw = `${file.name}:${file.size}:${file.lastModified}`
  let h = 0
  for (let i = 0; i < raw.length; i++) h = (h * 31 + raw.charCodeAt(i)) | 0
  return `v${h >>> 0}`
}

/**
 * Orchestrates the full local analysis pipeline:
 *   load engines -> extract audio (ffmpeg.wasm) -> detect beats (essentia.js)
 *   -> segment into 8-beat phrases -> AnalysisResult.
 *
 * Cancelable: {@link AnalyzePipeline.cancel} aborts in-flight work and
 * terminates the ffmpeg worker so its (large) WASM/core memory is released.
 */
export class AnalyzePipeline {
  private ffmpeg: FFmpeg | null = null
  private controller: AbortController | null = null

  private assertRunning(phase: AnalyzePhase): void {
    if (this.controller?.signal.aborted) {
      throw new AnalysisError(phase, 'CANCELLED', '分析已取消')
    }
  }

  async run(file: File, opts: AnalyzeOptions = {}): Promise<AnalyzeOutcome> {
    const cb = opts.callbacks ?? {}
    this.controller = new AbortController()
    const signal = this.controller.signal
    const videoId = opts.videoId ?? computeVideoId(file)
    const videoName = opts.videoName ?? file.name

    try {
      cb.onPhase?.('loading_engine')
      cb.onProgress?.('loading_engine', 5)
      const [ffmpeg, essentia] = await Promise.all([
        loadFfmpeg((_phase, r) => cb.onProgress?.('loading_engine', 5 + Math.round(r * 15))),
        loadEssentia(),
      ])
      this.ffmpeg = ffmpeg
      this.assertRunning('loading_engine')

      cb.onPhase?.('extracting')
      cb.onProgress?.('extracting', 20)
      const audio = await extractAudio(ffmpeg, file, { signal })
      this.assertRunning('extracting')

      cb.onPhase?.('detecting')
      cb.onProgress?.('detecting', 55)
      const { bpm, beats, confidence } = await detectBeats(essentia, audio, { signal })
      this.assertRunning('detecting')

      cb.onPhase?.('segmenting')
      cb.onProgress?.('segmenting', 85)
      const segments = segmentPhrases(beats, audio.duration)
      this.assertRunning('segmenting')

      const result: AnalysisResult = {
        taskId: videoId,
        videoName,
        bpm,
        confidence,
        duration: audio.duration,
        createdAt: new Date().toISOString(),
        segments,
        beatLowConfidence: confidence > 0 && confidence < LOW_CONFIDENCE,
      }
      cb.onProgress?.('done', 100)
      return { result, cleanup: () => this.release() }
    } catch (err) {
      if (
        signal.aborted ||
        (err instanceof AnalysisError && err.code === 'CANCELLED')
      ) {
        throw new AnalysisError('cancelled', 'CANCELLED', '分析已取消')
      }
      if (err instanceof AnalysisError) throw err
      const e = err as Error
      throw new AnalysisError('error', 'UNKNOWN', e?.message ?? '分析失败')
    }
  }

  /** Cancel the in-flight analysis and free ffmpeg's WASM memory. */
  cancel(): void {
    this.controller?.abort()
    this.release()
  }

  private release(): void {
    try {
      this.ffmpeg?.terminate()
    } catch {
      /* best effort */
    }
    this.ffmpeg = null
  }

  /**
   * Local low-confidence recompute — rebuilds the 8-beat grid without re-running
   * the heavy detection. Pure and synchronous.
   */
  static recompute(
    mode: RecomputeMode,
    ctx: { bpm: number; beats: number[]; duration: number },
    firstBeatTime?: number,
  ) {
    return recompute(mode, ctx, firstBeatTime)
  }
}
