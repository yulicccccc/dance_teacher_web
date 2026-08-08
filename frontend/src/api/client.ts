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
  onProgress?: (percent: number) => void
}

export const CHUNK_UPLOAD_THRESHOLD_BYTES = 8 * 1024 * 1024

interface ChunkUploadInitResponse {
  uploadId: string
  chunkSize: number
}

async function withNetworkRetry<T>(request: () => Promise<T>): Promise<T> {
  let lastError: unknown
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      return await request()
    } catch (error) {
      lastError = error
      const status = (error as AxiosError)?.response?.status
      const retryable = status == null || status === 408 || status === 429 || status >= 500
      if (!retryable || attempt === 2) throw error
      await new Promise<void>((resolve) => setTimeout(resolve, 500 * 2 ** attempt))
    }
  }
  throw lastError
}

async function uploadFileInChunks(
  file: File,
  onProgress?: (percent: number) => void,
): Promise<UploadResponse> {
  const { data: init } = await withNetworkRetry(() =>
    http.post<ChunkUploadInitResponse>(
      '/uploads/init',
      { filename: file.name, size: file.size },
      { timeout: 300000 },
    ),
  )
  const totalChunks = Math.ceil(file.size / init.chunkSize)

  for (let index = 0; index < totalChunks; index++) {
    const start = index * init.chunkSize
    const end = Math.min(file.size, start + init.chunkSize)
    const chunk = file.slice(start, end)
    await withNetworkRetry(() =>
      http.put(`/uploads/${init.uploadId}/chunks/${index}`, chunk, {
        headers: { 'Content-Type': 'application/octet-stream' },
        timeout: 300000,
        onUploadProgress: (event) => {
          const sent = Math.min(chunk.size, event.loaded)
          onProgress?.(Math.round(((start + sent) / file.size) * 100))
        },
      }),
    )
    onProgress?.(Math.round((end / file.size) * 100))
  }

  const { data } = await withNetworkRetry(() =>
    http.post<UploadResponse>(
      `/uploads/${init.uploadId}/complete`,
      { totalChunks },
      { timeout: 300000 },
    ),
  )
  return data
}

async function upload(args: UploadArgs): Promise<UploadResponse> {
  if (args.file) {
    if (args.file.size > CHUNK_UPLOAD_THRESHOLD_BYTES) {
      return uploadFileInChunks(args.file, args.onProgress)
    }
    const form = new FormData()
    form.append('file', args.file)
    const { data } = await http.post<UploadResponse>('/upload', form, {
      headers: { 'Content-Type': 'multipart/form-data' },
      // Extended timeout (5 min) to absorb cold-start wake-up + large file upload.
      timeout: 300000,
      onUploadProgress: (event) => {
        if (event.total) {
          args.onProgress?.(Math.round((event.loaded / event.total) * 100))
        }
      },
    })
    return data
  }
  if (args.url) {
    const { data } = await http.post<UploadResponse>(
      '/upload',
      { url: args.url },
      { timeout: 300000 },
    )
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
