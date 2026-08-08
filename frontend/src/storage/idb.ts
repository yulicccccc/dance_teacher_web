const DB_NAME = 'dance-teacher-videos'
const STORE = 'videos'
const VERSION = 1

export interface StoredVideo {
  file: File
  name: string
  size: number
  lastModified: number
}

function openDB(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, VERSION)
    req.onupgradeneeded = () => {
      const db = req.result
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE)
    }
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error)
  })
}

/** Persist a video File so its object URL can be rebuilt after a page reload. */
export async function idbPutVideo(videoId: string, file: File): Promise<void> {
  try {
    const db = await openDB()
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE, 'readwrite')
      tx.objectStore(STORE).put(
        { file, name: file.name, size: file.size, lastModified: file.lastModified } as StoredVideo,
        videoId,
      )
      tx.oncomplete = () => resolve()
      tx.onerror = () => reject(tx.error)
      db.close()
    })
  } catch {
    // best-effort persistence; the in-session object URL still works
  }
}

/** Read a previously persisted video File (or undefined if absent). */
export async function idbGetVideo(videoId: string): Promise<StoredVideo | undefined> {
  try {
    const db = await openDB()
    return await new Promise<StoredVideo | undefined>((resolve, reject) => {
      const tx = db.transaction(STORE, 'readonly')
      const rq = tx.objectStore(STORE).get(videoId)
      rq.onsuccess = () => resolve(rq.result as StoredVideo | undefined)
      rq.onerror = () => reject(rq.error)
      db.close()
    })
  } catch {
    return undefined
  }
}
