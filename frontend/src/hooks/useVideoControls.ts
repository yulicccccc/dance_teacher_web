import { useCallback, useRef } from 'react'

/**
 * Thin wrapper around the underlying <video> element. Slow-motion, seeking and
 * looping all rely on the element's native APIs — the beat timestamps live on
 * the true video timeline, so changing `playbackRate` never breaks alignment.
 */
export function useVideoControls() {
  const videoRef = useRef<HTMLVideoElement | null>(null)

  const play = useCallback(() => {
    void videoRef.current?.play().catch(() => undefined)
  }, [])

  const pause = useCallback(() => {
    videoRef.current?.pause()
  }, [])

  const togglePlay = useCallback(() => {
    const v = videoRef.current
    if (!v) return
    if (v.paused) void v.play().catch(() => undefined)
    else v.pause()
  }, [])

  const seek = useCallback((t: number) => {
    const v = videoRef.current
    if (v) v.currentTime = t
  }, [])

  const setRate = useCallback((r: number) => {
    const v = videoRef.current
    if (v) v.playbackRate = r
  }, [])

  return { videoRef, play, pause, togglePlay, seek, setRate }
}
