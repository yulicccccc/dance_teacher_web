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
  /** Beat dot click-through from the overlay (0-based dot index). When the
   *  overlay is used as a *segment* selector the parent passes `total` equal to
   *  the segment count so the dot count matches the selectable sections. */
  onDotClick?: (segmentIndex: number) => void
  /** Number of overlay dots. Defaults to 8 (a single phrase's beat count); the
   *  parent passes the segment count when the dots act as a section selector. */
  total?: number
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
export default function VideoPlayer({ src, mirror, videoRef, beatIndex, pulse, stepBeat, onDotClick, total }: Props) {
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
      // Double-click gesture: jump to the adjacent beat and freeze there. We
      // split the play area into LEFT / RIGHT halves by the container rect:
      //   * right half -> NEXT beat (stepBeat(+1))
      //   * left  half -> PREVIOUS beat (stepBeat(-1))
      // In mirror view the on-screen left/right is flipped, so the mapping is
      // inverted to match what the user sees. Play/pause is driven by the
      // external ControlBar (no single-click gesture here), so the double-click
      // gesture cannot conflict with it.
      onDoubleClick={(e) => {
        e.preventDefault()
        const el = containerRef.current
        if (!el || !stepBeat) return
        const rect = el.getBoundingClientRect()
        const onRightHalf = e.clientX - rect.left > rect.width / 2
        const dir: 1 | -1 = onRightHalf
          ? mirror
            ? -1
            : 1
          : mirror
            ? 1
            : -1
        stepBeat(dir)
      }}
    >
      <Box className="w-full h-full" sx={mirrorSx}>
        <video ref={videoRef} src={src} className="w-full h-full object-contain" playsInline />
      </Box>
      <BeatOverlay beatIndex={beatIndex} pulse={pulse} mirror={mirror} total={total} onDotClick={onDotClick} />
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
