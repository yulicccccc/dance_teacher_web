import type { DecodedAudio } from '../types/local'
import { idbGetVideo, idbPutVideo } from './idb'

export interface VideoEntry {
  file: File
  url: string
  name: string
  size: number
  lastModified: number
}

const entries = new Map<string, VideoEntry>()
const pcmCache = new Map<string, DecodedAudio>()

/**
 * Stable per-video id so progress survives re-uploads of the same file.
 * Byte-for-byte identical to the legacy Uploader implementation so existing
 * localStorage courses keep resolving to the same videoId.
 */
export function computeVideoId(file: File | null, url = ''): string {
  const raw = file
    ? `${file.name}:${file.size}:${file.lastModified}`
    : url || String(Math.random())
  let h = 0
  for (let i = 0; i < raw.length; i++) h = (h * 31 + raw.charCodeAt(i)) | 0
  return `v${h >>> 0}`
}

/** Register a selected file: create an object URL and persist the blob to IDB. */
export async function registerVideo(file: File): Promise<string> {
  const videoId = computeVideoId(file)
  const url = URL.createObjectURL(file)
  entries.set(videoId, {
    file,
    url,
    name: file.name,
    size: file.size,
    lastModified: file.lastModified,
  })
  await idbPutVideo(videoId, file)
  return videoId
}

/** Resolve a video entry from memory, or fall back to the IDB-persisted blob. */
export async function getVideo(videoId: string): Promise<VideoEntry | undefined> {
  const hit = entries.get(videoId)
  if (hit) return hit
  const stored = await idbGetVideo(videoId)
  if (stored) {
    const url = URL.createObjectURL(stored.file)
    const entry: VideoEntry = {
      file: stored.file,
      url,
      name: stored.name,
      size: stored.size,
      lastModified: stored.lastModified,
    }
    entries.set(videoId, entry)
    return entry
  }
  return undefined
}

export function getObjectURL(videoId: string): string | undefined {
  return entries.get(videoId)?.url
}

/** Cache decoded PCM in memory for the session (used by `auto` recompute). */
export function cachePcm(videoId: string, audio: DecodedAudio): void {
  pcmCache.set(videoId, audio)
}

export function getCachedPcm(videoId: string): DecodedAudio | undefined {
  return pcmCache.get(videoId)
}
