import { Box, IconButton, type SxProps, type Theme } from '@mui/material'
import FullscreenIcon from '@mui/icons-material/Fullscreen'
import FullscreenExitIcon from '@mui/icons-material/FullscreenExit'
import { useEffect, useRef, useState, type RefObject } from 'react'
import BeatOverlay from './BeatOverlay'

interface Props {
  src: string
  mirror: boolean
  videoRef: RefObject<HTMLVideoElement>
  beatIndex: number
  pulse: boolean
  /** Double-click gesture: seek to the adjacent beat and pause (1 = next, -1 = previous). */
  stepBeat?: (dir: 1 | -1) => void
}

/**
 * Wraps the native <video> with the mirror transform (simulated dance-studio
 * mirror, default on) and the beat overlay. All real-time sync is driven by
 * `useBeatSync` reading `videoRef`.
 *
 * A fullscreen button is overlaid on the container (top-right). We fullscreen
 * the *wrapper* element — not the inner <video> — so the mirror transform and
 * the beat overlay scale together with the video; `requestFullscreen` only
 * enlarges the container and leaves the inner layout untouched.
 */
export default function VideoPlayer({ src, mirror, videoRef, beatIndex, pulse, stepBeat }: Props) {
  const mirrorSx: SxProps<Theme> = mirror
    ? { transform: 'scaleX(-1)' }
    : { transform: 'none' }
  // Container ref for the Fullscreen API.
  const containerRef = useRef<HTMLDivElement | null>(null)
  const [isFullscreen, setIsFullscreen] = useState(false)

  useEffect(() => {
    const onChange = () => {
      setIsFullscreen(document.fullscreenElement === containerRef.current)
    }
    document.addEventListener('fullscreenchange', onChange)
    return () => document.removeEventListener('fullscreenchange', onChange)
  }, [])

  const toggleFullscreen = () => {
    const el = containerRef.current
    if (!el) return
    if (document.fullscreenElement) {
      void document.exitFullscreen()
      return
    }
    // Standard Fullscreen API, with a defensive webkit fallback for older Safari.
    const request =
      el.requestFullscreen ??
      (el as HTMLDivElement & { webkitRequestFullscreen?: () => Promise<void> })
        .webkitRequestFullscreen
    if (request) void request.call(el)
  }

  return (
    <Box
      ref={containerRef}
      className="relative w-full aspect-video bg-black rounded-xl overflow-hidden"
      // Double-click anywhere on the play area: jump to the NEXT beat and
      // freeze there; Shift+double-click jumps to the PREVIOUS beat. Play/pause
      // is driven by the external ControlBar (no single-click gesture on the
      // video itself), so the double-click gesture cannot conflict with it.
      onDoubleClick={(e) => {
        e.preventDefault()
        stepBeat?.(e.shiftKey ? -1 : 1)
      }}
    >
      <Box className="w-full h-full" sx={mirrorSx}>
        <video ref={videoRef} src={src} className="w-full h-full object-contain" playsInline />
      </Box>
      <BeatOverlay beatIndex={beatIndex} pulse={pulse} />
      <IconButton
        onClick={toggleFullscreen}
        // Swallow double-clicks so rapidly toggling fullscreen does not bubble
        // to the container and trigger a beat jump.
        onDoubleClick={(e) => e.stopPropagation()}
        aria-label={isFullscreen ? '退出全屏' : '全屏'}
        sx={{
          position: 'absolute',
          top: 8,
          right: 8,
          color: 'common.white',
          backgroundColor: 'rgba(0,0,0,0.35)',
          '&:hover': { backgroundColor: 'rgba(0,0,0,0.55)' },
        }}
      >
        {isFullscreen ? <FullscreenExitIcon /> : <FullscreenIcon />}
      </IconButton>
    </Box>
  )
}
