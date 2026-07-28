import { useCallback, useRef } from 'react'
import {
  useAnalysisStore,
  type AnalysisErrorCode,
} from '../store/analysisStore'
import { AnalyzePipeline } from './analyzePipeline'
import { useLocalProgress } from '../hooks/useLocalProgress'

/**
 * React binding for {@link AnalyzePipeline}. Exposes the analysis state machine
 * (`phase` / `progress` / `result` / `error`) read straight from
 * `useAnalysisStore`, plus `start(file, videoId, videoName)` and `cancel()`.
 *
 * On success the produced `AnalysisResult` is persisted into the local progress
 * store so "我的课程" and breakpoint-resume work without a backend.
 */
export function useAnalyzer() {
  const phase = useAnalysisStore((s) => s.phase)
  const progress = useAnalysisStore((s) => s.progress)
  const result = useAnalysisStore((s) => s.result)
  const error = useAnalysisStore((s) => s.error)
  const errorPhase = useAnalysisStore((s) => s.errorPhase)
  const errorCode = useAnalysisStore((s) => s.errorCode)
  const setPhase = useAnalysisStore((s) => s.setPhase)
  const setProgress = useAnalysisStore((s) => s.setProgress)
  const setResult = useAnalysisStore((s) => s.setResult)
  const setError = useAnalysisStore((s) => s.setError)
  const reset = useAnalysisStore((s) => s.reset)

  const pipelineRef = useRef<AnalyzePipeline | null>(null)
  const { saveCourse } = useLocalProgress()

  const start = useCallback(
    async (file: File, videoId: string, videoName: string) => {
      reset()
      const pipeline = new AnalyzePipeline()
      pipelineRef.current = pipeline
      try {
        const { result: res } = await pipeline.run(file, {
          videoId,
          videoName,
          callbacks: {
            onPhase: (p) => setPhase(p),
            onProgress: (_p, n) => setProgress(n),
          },
        })
        setResult(res)
        await saveCourse(videoId, {
          videoName: res.videoName,
          taskId: res.taskId,
          result: res,
          progress: {
            currentSegment: 1,
            playbackRate: 1,
            mirror: true,
            loopSegment: false,
            voiceEnabled: false,
            beatOffset: 0,
            learnedSegments: [],
            abLoop: null,
            updatedAt: new Date().toISOString(),
          },
        })
      } catch (e) {
        const err = e as { name?: string; code?: string; message?: string }
        if (err.name === 'AnalysisError' && err.code === 'CANCELLED') {
          setPhase('cancelled')
        } else {
          setError({
            phase: 'error',
            code: (err.code as AnalysisErrorCode) ?? 'UNKNOWN',
            message: err.message ?? '分析失败',
          })
        }
      }
    },
    [reset, setPhase, setProgress, setResult, setError, saveCourse],
  )

  const cancel = useCallback(() => {
    pipelineRef.current?.cancel()
  }, [])

  return { phase, progress, result, error, errorPhase, errorCode, start, cancel, reset }
}
