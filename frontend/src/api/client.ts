import axios, { type AxiosError, type AxiosInstance } from 'axios'
import type {
  AnalysisResult,
  ApiError,
  RecomputeRequest,
  TaskStatus,
  UploadResponse,
} from '../types/api'

const BASE: string = (import.meta.env.VITE_API_BASE as string | undefined) ?? '/api/v1'

export const http: AxiosInstance = axios.create({
  baseURL: BASE,
  timeout: 60000,
})

export interface UploadArgs {
  file?: File
  url?: string
}

async function upload(args: UploadArgs): Promise<UploadResponse> {
  if (args.file) {
    const form = new FormData()
    form.append('file', args.file)
    const { data } = await http.post<UploadResponse>('/upload', form, {
      headers: { 'Content-Type': 'multipart/form-data' },
      // Extended timeout (5 min) to absorb cold-start wake-up + large file upload.
      timeout: 300000,
    })
    return data
  }
  if (args.url) {
    const { data } = await http.post<UploadResponse>('/upload', { url: args.url })
    return data
  }
  throw new Error('必须提供 file 或 url')
}

async function getStatus(taskId: string): Promise<TaskStatus> {
  const { data } = await http.get<TaskStatus>(`/analysis/${taskId}`)
  return data
}

async function getResult(taskId: string): Promise<AnalysisResult> {
  const { data } = await http.get<AnalysisResult>(`/analysis/${taskId}/result`)
  return data
}

async function retry(taskId: string): Promise<UploadResponse> {
  const { data } = await http.post<UploadResponse>(`/analysis/${taskId}/retry`)
  return data
}

async function recompute(taskId: string, req: RecomputeRequest): Promise<AnalysisResult> {
  const { data } = await http.post<AnalysisResult>(`/analysis/${taskId}/recompute`, req)
  return data
}

async function health(): Promise<{ status: string }> {
  const { data } = await http.get<{ status: string }>('/health')
  return data
}

/**
 * Warm up the (possibly sleeping) backend. Render free instances sleep after
 * 15 min idle and need 30-90s to wake. The first request triggers the wake-up
 * but may be cut off; retrying raises the success rate. All errors are
 * swallowed — this is purely best-effort and the result is ignored by callers.
 */
async function warmup(): Promise<void> {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      await http.get<{ status: string }>('/health', { timeout: 120000 })
      return
    } catch {
      // Swallow everything: the request already nudged the instance awake.
    }
    if (attempt < 2) {
      // Wait ~10s before retry to let the instance finish booting.
      await new Promise<void>((resolve) => setTimeout(resolve, 10000))
    }
  }
}

/** Normalize any axios / network error into our uniform ApiError shape. */
export function extractApiError(err: unknown): ApiError {
  const httpErr = err as AxiosError<{ code?: string; message?: string }>
  const detail = httpErr?.response?.data
  return {
    code: detail?.code ?? 'UNKNOWN',
    message: detail?.message ?? httpErr?.message ?? '未知错误',
    data: null,
  }
}

export const apiClient = {
  BASE,
  upload,
  getStatus,
  getResult,
  retry,
  recompute,
  health,
  warmup,
}

export default apiClient
