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
}

export default apiClient
