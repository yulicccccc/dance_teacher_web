import { MAX_SIZE_MB } from '../audio/constants'
import { ErrorCode } from './errorCodes'

export interface ValidationResult {
  ok: boolean
  code?: ErrorCode
  message?: string
}

const ALLOWED_TYPES = ['video/mp4', 'video/webm', 'video/quicktime', 'video/x-matroska']
const ALLOWED_EXT = ['mp4', 'webm', 'mov', 'mkv']

/**
 * Lightweight pre-decode check. Some browsers don't report a MIME type for
 * picked files, so we also accept a known video extension. Duration (the other
 * hard cap) is enforced after decode in the pipeline.
 */
export function validateVideoFile(file: File): ValidationResult {
  const ext = file.name.toLowerCase().split('.').pop() ?? ''
  const typeOk = file.type
    ? ALLOWED_TYPES.includes(file.type)
    : ALLOWED_EXT.includes(ext)
  if (!typeOk) {
    return { ok: false, code: ErrorCode.INVALID_FILE_TYPE, message: '请上传 mp4 / webm / mov 视频' }
  }
  if (file.size > MAX_SIZE_MB * 1024 * 1024) {
    return {
      ok: false,
      code: ErrorCode.FILE_TOO_LARGE,
      message: `视频不能超过 ${MAX_SIZE_MB}MB`,
    }
  }
  return { ok: true }
}
