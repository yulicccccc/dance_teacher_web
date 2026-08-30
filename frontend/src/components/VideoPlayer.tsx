import { Box, IconButton, type SxProps, type Theme } from '@mui/material'
import FullscreenIcon from '@mui/icons-material/Fullscreen'
import FullscreenExitIcon from '@mui/icons-material/FullscreenExit'
import { useEffect, useRef, useState, type RefObject } from 'react'
import BeatOverlay from './BeatOverlay'

interface Props {
  src: string
  mirror: boolean
  beatMirror: boolean
  videoRef: RefObject<HTMLVideoElement>
  beatIndex: number
  pulse: boolean
  /** Single-click / keyboard playback toggle supplied by the page controller. */
  onTogglePlay?: () => void
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
export default function VideoPlayer({
  src,
  mirror,
  beatMirror,
  videoRef,
  beatIndex,
  pulse,
  onTogglePlay,
  stepBeat,
  onDotClick,
  total,
}: Props) {
  const mirrorSx: SxProps<Theme> = mirror
    ? { transform: 'scaleX(-1)' }
    : { transform: 'none' }
  // Container ref for the Fullscreen API.
  const containerRef = useRef<HTMLDivElement | null>(null)
  const singleClickTimerRef = useRef<number | null>(null)
  const [isFullscreen, setIsFullscreen] = useState(false)

  useEffect(() => {
    const video = videoRef.current as
      | (HTMLVideoElement & { webkitDisplayingFullscreen?: boolean })
      | null
    const webkitDocument = document as Document & {
      webkitFullscreenElement?: Element | null
    }
    const onChange = () => {
      setIsFullscreen(
        document.fullscreenElement === containerRef.current ||
          webkitDocument.webkitFullscreenElement === containerRef.current ||
          video?.webkitDisplayingFullscreen === true,
      )
    }
    document.addEventListener('fullscreenchange', onChange)
    document.addEventListener('webkitfullscreenchange', onChange)
    video?.addEventListener('webkitbeginfullscreen', onChange)
    video?.addEventListener('webkitendfullscreen', onChange)
    return () => {
      document.removeEventListener('fullscreenchange', onChange)
      document.removeEventListener('webkitfullscreenchange', onChange)
      video?.removeEventListener('webkitbeginfullscreen', onChange)
      video?.removeEventListener('webkitendfullscreen', onChange)
      if (singleClickTimerRef.current !== null) {
        window.clearTimeout(singleClickTimerRef.current)
      }
    }
  }, [videoRef])

  const cancelPendingSingleClick = () => {
    if (singleClickTimerRef.current === null) return
    window.clearTimeout(singleClickTimerRef.current)
    singleClickTimerRef.current = null
  }

  const schedulePlaybackToggle = () => {
    if (!onTogglePlay) return
    cancelPendingSingleClick()
    // Wait briefly so a double-click can claim the gesture without producing
    // two transient play/pause toggles first.
    singleClickTimerRef.current = window.setTimeout(() => {
      singleClickTimerRef.current = null
      onTogglePlay()
    }, 220)
  }

  const toggleFullscreen = () => {
    const el = containerRef.current
    if (!el) return
    const webkitDocument = document as Document & {
      webkitFullscreenElement?: Element | null
      webkitExitFullscreen?: () => Promise<void> | void
    }
    const fullscreenElement =
      document.fullscreenElement ?? webkitDocument.webkitFullscreenElement
    if (fullscreenElement) {
      if (document.exitFullscreen) void document.exitFullscreen()
      else void webkitDocument.webkitExitFullscreen?.()
      return
    }
    const enterNativeVideoFullscreen = () => {
      const video = videoRef.current as
        | (HTMLVideoElement & { webkitEnterFullscreen?: () => void })
        | null
      video?.webkitEnterFullscreen?.()
    }
    // Standard Fullscreen API, with wrapper/video fallbacks for Safari/iPhone.
    const request =
      el.requestFullscreen ??
      (el as HTMLDivElement & {
        webkitRequestFullscreen?: () => Promise<void> | void
      })
        .webkitRequestFullscreen
    if (!request) {
      enterNativeVideoFullscreen()
      return
    }
    try {
      void Promise.resolve(request.call(el)).catch(enterNativeVideoFullscreen)
    } catch {
      enterNativeVideoFullscreen()
    }
  }

  return (
    <Box
      ref={containerRef}
      className="relative w-full aspect-video bg-black rounded-xl overflow-hidden"
      role="region"
      tabIndex={0}
      aria-label="视频播放区：单击播放或暂停；双击左侧上一拍、中间全屏、右侧下一拍；逗号前一拍、句号后一拍"
      title="单击播放/暂停 · 双击左侧上一拍 · 中间全屏 · 右侧下一拍 · , 前一拍 · . 后一拍"
      onClick={schedulePlaybackToggle}
      // Physical LEFT / CENTRE / RIGHT thirds keep the gesture independent of
      // video mirroring: previous beat / fullscreen / next beat.
      onDoubleClick={(e) => {
        e.preventDefault()
        cancelPendingSingleClick()
        const el = containerRef.current
        if (!el) return
        const rect = el.getBoundingClientRect()
        const relativeX = e.clientX - rect.left
        if (relativeX < rect.width / 3) stepBeat?.(-1)
        else if (relativeX > (rect.width * 2) / 3) stepBeat?.(1)
        else toggleFullscreen()
      }}
      onKeyDown={(e) => {
        if (e.target !== e.currentTarget) return
        const key = e.key.toLowerCase()
        if (key === ' ' || key === 'enter' || key === 'k') {
          e.preventDefault()
          if (!e.repeat) onTogglePlay?.()
        } else if (e.code === 'Comma' || key === ',' || key === '，') {
          e.preventDefault()
          stepBeat?.(-1)
        } else if (e.code === 'Period' || key === '.' || key === '。') {
          e.preventDefault()
          stepBeat?.(1)
        } else if (key === 'arrowleft') {
          e.preventDefault()
          stepBeat?.(-1)
        } else if (key === 'arrowright') {
          e.preventDefault()
          stepBeat?.(1)
        } else if (key === 'f') {
          e.preventDefault()
          if (!e.repeat) toggleFullscreen()
        }
      }}
      sx={{ cursor: 'pointer', touchAction: 'manipulation', userSelect: 'none' }}
    >
      <Box className="w-full h-full" sx={mirrorSx}>
        <video ref={videoRef} src={src} className="w-full h-full object-contain" playsInline />
      </Box>
      <BeatOverlay
        beatIndex={beatIndex}
        pulse={pulse}
        mirror={beatMirror}
        total={total}
        onDotClick={onDotClick}
      />
      <IconButton
        onClick={(e) => {
          e.stopPropagation()
          toggleFullscreen()
        }}
        // Swallow double-clicks so rapidly toggling fullscreen does not bubble
        // to the container and trigger a beat jump.
        onDoubleClick={(e) => {
          e.preventDefault()
          e.stopPropagation()
        }}
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
