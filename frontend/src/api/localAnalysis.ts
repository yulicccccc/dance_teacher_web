import { decodeAudioFile } from '../audio/decodeAudio'
import { detectBeats } from '../workers/beatWorkerClient'
import { buildResult } from '../audio/buildResult'
import { recomputeLocal } from '../audio/recompute'
import { registerVideo, cachePcm, getCachedPcm, getVideo } from '../storage/videoRegistry'
import { getTask, upsertTask } from '../store/analysisStore'
import { validateVideoFile } from '../utils/mediaValidate'
import { MAX_DURATION_SEC } from '../audio/constants'
import type { AnalysisResult, RecomputeRequest, TaskStatus } from '../types/api'

function newTaskId(): string {
  return `local-${Math.random().toString(36).slice(2, 10)}`
}

/**
 * Full browser-side pipeline: validate → decode → detect → segment. Progress is
 * published to the in-memory analysis store (subscribed by AnalysisPage). On
 * success the result lives in the store (and localStorage), so LessonPage can
 * read it without any backend.
 */
export async function startLocalAnalysis(
  file: File,
  videoId: string,
  taskId = newTaskId(),
): Promise<string> {
  const base = getTask(taskId) ?? {
    taskId,
    videoId,
    videoName: file.name,
    status: 'queued' as const,
    progress: 0,
    result: null,
    error: null,
    createdAt: new Date().toISOString(),
  }
  upsertTask({ ...base, status: 'queued', progress: 0, error: null })

  try {
    const v = validateVideoFile(file)
    if (!v.ok) throw new Error(v.message)

    upsertTask({ ...getTask(taskId)!, status: 'extracting', progress: 10 })
    const audio = await decodeAudioFile(file)
    if (audio.duration > MAX_DURATION_SEC) {
      throw new Error(`视频时长不能超过 ${MAX_DURATION_SEC} 秒`)
    }
    // Cache decoded PCM for later `auto` recompute within this session.
    cachePcm(videoId, audio)

    upsertTask({ ...getTask(taskId)!, status: 'beat_detecting', progress: 40 })
    const detect = await detectBeats(audio)

    upsertTask({ ...getTask(taskId)!, status: 'segmenting', progress: 80 })
    const result = buildResult({
      taskId,
      videoName: file.name,
      bpm: detect.bpm,
      confidence: detect.confidence,
      duration: detect.duration,
      beatTimes: detect.beatTimes,
    })

    upsertTask({ ...getTask(taskId)!, status: 'done', progress: 100, result })
    return taskId
  } catch (e) {
    upsertTask({
      ...getTask(taskId)!,
      status: 'failed',
      error: e instanceof Error ? e.message : String(e),
    })
    throw e
  }
}

export function getLocalResult(taskId: string): AnalysisResult | null {
  return getTask(taskId)?.result ?? null
}

export function getLocalStatus(taskId: string): TaskStatus | null {
  const t = getTask(taskId)
  if (!t) return null
  return {
    taskId: t.taskId,
    status: t.status,
    progress: t.progress,
    result: t.result,
    error: t.error,
  }
}

/**
 * Local recompute (fixed120 / fixedBpm / manual_first_beat are pure; `auto`
 * re-runs the detector on the cached PCM). Returns the rebuilt AnalysisResult
 * and updates the store so LessonPage re-renders with the new grid.
 */
export async function recomputeLocalTask(
  taskId: string,
  req: RecomputeRequest,
): Promise<AnalysisResult> {
  const t = getTask(taskId)
  if (!t || !t.result) throw new Error('未找到分析结果，请重新上传视频')
  const duration = t.result.duration
  const bpm = t.result.bpm

  if (req.mode === 'auto') {
    const audio = getCachedPcm(t.videoId)
    if (!audio) throw new Error('自动重算需要原视频，请重新上传后再试')
    const detect = await detectBeats(audio)
    const result = buildResult({
      taskId,
      videoName: t.result.videoName,
      bpm: detect.bpm,
      confidence: detect.confidence,
      duration: detect.duration,
      beatTimes: detect.beatTimes,
    })
    upsertTask({ ...t, result })
    return result
  }

  const out = await recomputeLocal(req, { duration, bpm })
  const result = buildResult({
    taskId,
    videoName: t.result.videoName,
    bpm: out.bpm,
    confidence: out.confidence,
    duration,
    beatTimes: out.beatTimes,
  })
  upsertTask({ ...t, result })
  return result
}

/** Re-run the whole pipeline for a previously registered video (same taskId). */
export async function retryLocalAnalysis(taskId: string): Promise<string> {
  const t = getTask(taskId)
  if (!t) throw new Error('未找到任务')
  const entry = await getVideo(t.videoId)
  if (!entry) throw new Error('视频已不在，请重新上传')
  return startLocalAnalysis(entry.file, t.videoId, taskId)
}

// Re-exported for any stray import site; the zero-server build needs no BASE.
export const localAnalysis = {
  BASE: '',
  health: async () => ({ status: 'ok' as const }),
  warmup: async () => undefined,
}

// Keep registerVideo referenced (used by UploadPage) so tree-shaking warnings
// stay honest; this also documents the module's public surface.
export { registerVideo }
