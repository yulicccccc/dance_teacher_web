import { Box, IconButton, type SxProps, type Theme } from '@mui/material'
import FullscreenIcon from '@mui/icons-material/Fullscreen'
import FullscreenExitIcon from '@mui/icons-material/FullscreenExit'
import { useEffect, useRef, useState, type RefObject } from 'react'
import BeatOverlay from './BeatOverlay'
import type { LoopMode } from '../store/lessonStore'

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
  onPrevSegment?: () => void
  onNextSegment?: () => void
  onAdjustPlaybackRate?: (dir: 1 | -1) => void
  onResetPlaybackRate?: () => void
  onToggleLoop?: () => void
  onSelectLoopMode?: (mode: LoopMode) => void
  onSetA?: () => void
  onSetB?: () => void
  onClearAB?: () => void
  onToggleMirror?: () => void
  onToggleBeatMirror?: () => void
  onToggleVoice?: () => void
  onToggleMetronome?: () => void
  onToggleLearned?: () => void
  onShowShortcuts?: () => void
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
  onPrevSegment,
  onNextSegment,
  onAdjustPlaybackRate,
  onResetPlaybackRate,
  onToggleLoop,
  onSelectLoopMode,
  onSetA,
  onSetB,
  onClearAB,
  onToggleMirror,
  onToggleBeatMirror,
  onToggleVoice,
  onToggleMetronome,
  onToggleLearned,
  onShowShortcuts,
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
      aria-label="视频播放区：单击播放或暂停；双击左侧上一拍、中间全屏、右侧下一拍；按问号查看全部快捷键"
      title="单击播放/暂停 · 双击逐拍/全屏 · 按 ? 查看全部快捷键"
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
        // Preserve browser and operating-system shortcuts such as Cmd/Ctrl+R.
        if (e.metaKey || e.ctrlKey || e.altKey) return
        const key = e.key.toLowerCase()
        const loopModeShortcut = e.code.match(/^(?:Digit|Numpad)([1-6])$/)
        if (key === ' ' || key === 'enter' || key === 'k') {
          e.preventDefault()
          if (!e.repeat) onTogglePlay?.()
        } else if (
          e.shiftKey &&
          (e.code === 'Comma' || key === '<' || key === '《')
        ) {
          e.preventDefault()
          onAdjustPlaybackRate?.(-1)
        } else if (
          e.shiftKey &&
          (e.code === 'Period' || key === '>' || key === '》')
        ) {
          e.preventDefault()
          onAdjustPlaybackRate?.(1)
        } else if (e.code === 'Comma' || key === ',' || key === '，') {
          e.preventDefault()
          stepBeat?.(-1)
        } else if (e.code === 'Period' || key === '.' || key === '。') {
          e.preventDefault()
          stepBeat?.(1)
        } else if (
          (e.shiftKey && key === 'arrowleft') ||
          (!e.shiftKey && (e.code === 'BracketLeft' || key === '[' || key === '【'))
        ) {
          e.preventDefault()
          onPrevSegment?.()
        } else if (
          (e.shiftKey && key === 'arrowright') ||
          (!e.shiftKey && (e.code === 'BracketRight' || key === ']' || key === '】'))
        ) {
          e.preventDefault()
          onNextSegment?.()
        } else if (key === 'arrowleft') {
          e.preventDefault()
          stepBeat?.(-1)
        } else if (key === 'arrowright') {
          e.preventDefault()
          stepBeat?.(1)
        } else if (e.code === 'Minus' || e.code === 'NumpadSubtract' || key === '-') {
          e.preventDefault()
          onAdjustPlaybackRate?.(-1)
        } else if (
          e.code === 'Equal' ||
          e.code === 'NumpadAdd' ||
          key === '=' ||
          key === '+'
        ) {
          e.preventDefault()
          onAdjustPlaybackRate?.(1)
        } else if (e.code === 'Digit0' || e.code === 'Numpad0' || key === '0') {
          e.preventDefault()
          if (!e.repeat) onResetPlaybackRate?.()
        } else if (key === 'r') {
          e.preventDefault()
          if (!e.repeat) onToggleLoop?.()
        } else if (key === 'm') {
          e.preventDefault()
          if (!e.repeat) {
            if (e.shiftKey) onToggleBeatMirror?.()
            else onToggleMirror?.()
          }
        } else if (key === 'c') {
          e.preventDefault()
          if (!e.repeat) {
            if (e.shiftKey) onToggleMetronome?.()
            else onToggleVoice?.()
          }
        } else if (key === 'd') {
          e.preventDefault()
          if (!e.repeat) onToggleLearned?.()
        } else if (!e.shiftKey && loopModeShortcut) {
          e.preventDefault()
          if (!e.repeat) {
            const modes: LoopMode[] = ['current', 'front', 'back', 'single', 'multi', 'ab']
            onSelectLoopMode?.(modes[Number(loopModeShortcut[1]) - 1])
          }
        } else if (key === 'a') {
          e.preventDefault()
          if (!e.repeat) onSetA?.()
        } else if (key === 'b') {
          e.preventDefault()
          if (!e.repeat) onSetB?.()
        } else if (key === 'x') {
          e.preventDefault()
          if (!e.repeat) onClearAB?.()
        } else if (key === 'f') {
          e.preventDefault()
          if (!e.repeat) toggleFullscreen()
        } else if (key === '?') {
          e.preventDefault()
          if (!e.repeat) onShowShortcuts?.()
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
