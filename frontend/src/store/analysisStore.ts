import { create } from 'zustand'
import type { AnalysisResult } from '../types/api'

/**
 * State machine for the local analysis pipeline. The UI subscribes to `phase`
 * + `progress`; `useAnalyzer` drives the transitions and writes the final
 * `result` / `error`. Phases mirror the architecture's shared convention
 * (§8): `idle | loading_engine | extracting | detecting | segmenting | done |
 * error | cancelled`.
 */
export type AnalyzePhase =
  | 'idle'
  | 'loading_engine'
  | 'extracting'
  | 'detecting'
  | 'segmenting'
  | 'done'
  | 'error'
  | 'cancelled'

export type AnalysisErrorCode =
  | 'ENGINE_LOAD'
  | 'EXTRACT'
  | 'DETECT'
  | 'SEGMENT'
  | 'CANCELLED'
  | 'FILE_TOO_LARGE'
  | 'UNKNOWN'

export interface AnalysisErrorInfo {
  phase: AnalyzePhase
  code: AnalysisErrorCode
  message: string
}

interface AnalysisStoreState {
  phase: AnalyzePhase
  progress: number // 0~100
  result: AnalysisResult | null
  error: string | null
  errorPhase: AnalyzePhase | null
  errorCode: AnalysisErrorCode | null
  setPhase: (p: AnalyzePhase) => void
  setProgress: (n: number) => void
  setResult: (r: AnalysisResult) => void
  setError: (info: AnalysisErrorInfo) => void
  reset: () => void
}

export const useAnalysisStore = create<AnalysisStoreState>((set) => ({
  phase: 'idle',
  progress: 0,
  result: null,
  error: null,
  errorPhase: null,
  errorCode: null,
  setPhase: (phase) => set({ phase }),
  setProgress: (progress) => set({ progress }),
  setResult: (result) =>
    set({
      result,
      phase: 'done',
      progress: 100,
      error: null,
      errorPhase: null,
      errorCode: null,
    }),
  setError: (info) =>
    set({
      phase: 'error',
      error: info.message,
      errorPhase: info.phase,
      errorCode: info.code,
    }),
  reset: () =>
    set({
      phase: 'idle',
      progress: 0,
      result: null,
      error: null,
      errorPhase: null,
      errorCode: null,
    }),
}))

/** Non-reactive snapshot accessor (handy for tests / debugging). */
export function getAnalysisState() {
  return useAnalysisStore.getState()
}
