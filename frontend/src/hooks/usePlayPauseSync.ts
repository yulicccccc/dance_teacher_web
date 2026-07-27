import { useEffect } from 'react'
import type { RefObject } from 'react'
import type { Segment } from '../types/api'

/**
 * Track the real play/pause state of a `<video>` element so the control bar can
 * show the correct icon.
 *
 * `videoRef.current` is `null` on the very first render because `VideoPlayer`
 * only mounts the `<video>` AFTER `result` loads. `segments` flips from `[]` to
 * the real array at exactly the same render that mounts the element, so
 * depending on `segments` (alongside `videoRef`) guarantees this effect re-runs
 * once the element exists and the real `play`/`pause` events start flipping the
 * `playing` flag. (Bug C)
 *
 * If the dependency were only `[videoRef]`, the effect would run once on the
 * first render when `videoRef.current` is still `null`, attach nothing, and
 * never re-run after the element mounts — so the play/pause icon would stay
 * frozen on the initial value forever.
 */
export function usePlayPauseSync(
  videoRef: RefObject<HTMLVideoElement>,
  segments: Segment[],
  setPlaying: (playing: boolean) => void,
): void {
  useEffect(() => {
    const v = videoRef.current
    if (!v) return
    const onPlay = () => setPlaying(true)
    const onPause = () => setPlaying(false)
    v.addEventListener('play', onPlay)
    v.addEventListener('pause', onPause)
    // Sync immediately in case the element is already playing/paused (e.g. a
    // cached video or a re-render after a seek), so the icon is never stale.
    if (v.readyState >= 1) setPlaying(!v.paused)
    return () => {
      v.removeEventListener('play', onPlay)
      v.removeEventListener('pause', onPause)
    }
  }, [segments, videoRef, setPlaying])
}
