import { create } from 'zustand'

/**
 * Holds the in-flight upload: the selected `File`, a local object URL for
 * immediate playback, and a stable `videoId` used as the route param and as the
 * key for the local progress store / video cache. The object URL is
 * session-scoped — it is created on `setFile` and revoked on `clear` (or when
 * replaced) to avoid leaking blob URLs / memory.
 */
export interface UploadSessionState {
  videoFile: File | null
  objectUrl: string | null
  videoId: string
  videoName: string
  /** Set the current upload and create a local object URL for playback. */
  setFile: (file: File, videoId: string, videoName: string) => void
  /** Restore a previously cached object URL (e.g. from IndexedDB) without a File. */
  setObjectUrl: (objectUrl: string, videoId: string, videoName: string) => void
  /** Revoke the object URL and forget the upload. */
  clear: () => void
}

export const useUploadSession = create<UploadSessionState>((set, get) => ({
  videoFile: null,
  objectUrl: null,
  videoId: '',
  videoName: '',
  setFile: (file, videoId, videoName) => {
    const prev = get().objectUrl
    if (prev) URL.revokeObjectURL(prev)
    set({ videoFile: file, objectUrl: URL.createObjectURL(file), videoId, videoName })
  },
  setObjectUrl: (objectUrl, videoId, videoName) => {
    const prev = get().objectUrl
    if (prev && prev !== objectUrl) URL.revokeObjectURL(prev)
    set({ objectUrl, videoId, videoName, videoFile: get().videoFile })
  },
  clear: () => {
    const prev = get().objectUrl
    if (prev) URL.revokeObjectURL(prev)
    set({ videoFile: null, objectUrl: null, videoId: '', videoName: '' })
  },
}))
