export const ErrorCode = {
  UNKNOWN: 'UNKNOWN',
  INVALID_FILE_TYPE: 'INVALID_FILE_TYPE',
  FILE_TOO_LARGE: 'FILE_TOO_LARGE',
  DECODE_FAILED: 'DECODE_FAILED',
  DETECT_FAILED: 'DETECT_FAILED',
  NO_VIDEO: 'NO_VIDEO',
} as const

export type ErrorCode = (typeof ErrorCode)[keyof typeof ErrorCode]
