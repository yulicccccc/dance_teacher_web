/**
 * Best-effort IndexedDB cache of the uploaded video `File`, so a previously
 * analysed course can be replayed from "我的课程" without re-uploading. Object
 * URLs are session-scoped, so we re-create one from the cached `File` on demand
 * via {@link getVideoUrl}. All failures are swallowed — this is a convenience
 * cache, never on the critical path.
 */
const DB_NAME = 'dance-teacher-video'
const STORE = 'videos'

function openDB(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1)
    req.onupgradeneeded = () => {
      const db = req.result
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE)
    }
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error)
  })
}

async function idbPut(key: string, value: unknown): Promise<void> {
  try {
    const db = await openDB()
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE, 'readwrite')
      tx.objectStore(STORE).put(value, key)
      tx.oncomplete = () => resolve()
      tx.onerror = () => reject(tx.error)
      db.close()
    })
  } catch {
    /* best effort */
  }
}

async function idbGet(key: string): Promise<File | undefined> {
  try {
    const db = await openDB()
    return await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, 'readonly')
      const req = tx.objectStore(STORE).get(key)
      req.onsuccess = () => resolve(req.result as File | undefined)
      req.onerror = () => reject(req.error)
      db.close()
    })
  } catch {
    return undefined
  }
}

async function idbDelete(key: string): Promise<void> {
  try {
    const db = await openDB()
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE, 'readwrite')
      tx.objectStore(STORE).delete(key)
      tx.oncomplete = () => resolve()
      tx.onerror = () => reject(tx.error)
      db.close()
    })
  } catch {
    /* best effort */
  }
}

/** Persist the video file for later replay. */
export async function cacheVideo(videoId: string, file: File): Promise<void> {
  await idbPut(videoId, file)
}

/** Re-create a local object URL for a previously cached video, if present. */
export async function getVideoUrl(videoId: string): Promise<string | null> {
  const file = await idbGet(videoId)
  if (!file) return null
  try {
    return URL.createObjectURL(file)
  } catch {
    return null
  }
}

/** Remove a cached video (e.g. when its course is deleted). */
export async function removeVideo(videoId: string): Promise<void> {
  await idbDelete(videoId)
}
