import { useCallback, useEffect, useRef, useState, type RefObject } from 'react'
import {
  Box,
  Button,
  IconButton,
  Stack,
  Tooltip,
  Typography,
} from '@mui/material'
import VideocamIcon from '@mui/icons-material/Videocam'
import StopIcon from '@mui/icons-material/Stop'
import FiberManualRecordIcon from '@mui/icons-material/FiberManualRecord'
import DownloadIcon from '@mui/icons-material/Download'
import ReplayIcon from '@mui/icons-material/Replay'
import CloseIcon from '@mui/icons-material/Close'
import FlipIcon from '@mui/icons-material/Flip'
import type { Segment } from '../types/api'
import { useLessonStore } from '../store/lessonStore'
import { compareFileName, pickMimeType } from '../utils/compare'
import {
  playCountVoice,
  prepareComparisonAudio,
} from '../audio/countVoiceAudio'

type Phase = 'loading' | 'denied' | 'ready' | 'recording' | 'review' | 'unsupported'

const CANVAS_W = 1280
const CANVAS_H = 720
const HALF_W = CANVAS_W / 2

interface Props {
  /** Whether the split-screen comparison is active (drives the camera lifecycle). */
  open: boolean
  onClose: () => void
  /**
   * The PAGE-LEVEL teacher `<video>` ref — the very same element that
   * `VideoPlayer` renders and that the bottom `ControlBar` drives.
   *
   * Reusing it (instead of mounting a private teacher video, as the old modal
   * did) is what keeps play/pause, prev/next, speed, mirror, loop and A→B fully
   * live while the comparison is on: there is simply nothing to synchronise,
   * because both sides act on one element. The panel only *reads* it — it draws
   * it into the left half of the canvas and pauses/seeks it around a recording.
   */
  teacherVideoRef: RefObject<HTMLVideoElement>
  /** Teacher video source URL (same-origin preferred so the canvas isn't tainted). */
  src: string
  /** The segment to record (one 8-beat phrase). */
  segment: Segment | null
  segmentIndex: number
  /** Studio-mirror: applied to BOTH halves so left/right line up for comparison. */
  mirror: boolean
  /** Live beat state from the shared teacher timeline. */
  beatIndex?: number
  pulse?: boolean
  /** Mirror the count overlay independently from the two video halves. */
  beatMirror?: boolean
  /** Whether the shared count-command audio is currently enabled. */
  voiceEnabled?: boolean
  /** Shared count-command volume (0–2) used by practice and recording. */
  voiceVolume?: number
  videoName: string
}

/** Draw one video source into the left or right half, object-fit contain, optional mirror. */
function drawHalf(
  ctx: CanvasRenderingContext2D,
  video: HTMLVideoElement,
  x: number,
  mirror: boolean,
) {
  const vw = video.videoWidth
  const vh = video.videoHeight
  if (!vw || !vh) return
  ctx.save()
  ctx.beginPath()
  ctx.rect(x, 0, HALF_W, CANVAS_H)
  ctx.clip()
  ctx.translate(x + HALF_W / 2, 0)
  if (mirror) ctx.scale(-1, 1)
  const scale = Math.min(HALF_W / vw, CANVAS_H / vh)
  const dw = vw * scale
  const dh = vh * scale
  ctx.drawImage(video, -dw / 2, (CANVAS_H - dh) / 2, dw, dh)
  ctx.restore()
}

/** Draw the same 1–8 count and dot row into the recorded canvas. */
function drawBeatOverlay(
  ctx: CanvasRenderingContext2D,
  beatIndex: number,
  pulse: boolean,
  mirror: boolean,
) {
  if (beatIndex < 1 || beatIndex > 8) return
  const overlayWidth = 230
  ctx.save()
  if (mirror) {
    ctx.translate(overlayWidth, 0)
    ctx.scale(-1, 1)
  }
  ctx.fillStyle = 'rgba(255,255,255,0.96)'
  ctx.font = `bold ${pulse ? 84 : 76}px sans-serif`
  ctx.fillText(String(beatIndex), 24, 120)
  for (let index = 0; index < 8; index += 1) {
    const active = index + 1 === beatIndex
    const size = active && pulse ? 15 : 11
    ctx.fillStyle = active ? '#22d3ee' : 'rgba(255,255,255,0.36)'
    ctx.fillRect(24 + index * 22, 142 - (size - 11) / 2, size, size)
  }
  ctx.restore()
}

/**
 * In-place side-by-side comparison panel (teacher left / learner right).
 *
 * Rendered INLINE in the lesson layout — it replaces the visible player area
 * only, so the segment list on the left and the control bar underneath stay
 * mounted and usable. Recording composites both halves into one canvas stream,
 * so the produced webm is already side-by-side.
 */
export default function CompareMode({
  open,
  onClose,
  teacherVideoRef,
  src,
  segment,
  segmentIndex,
  mirror,
  beatIndex = 0,
  pulse = false,
  beatMirror = false,
  voiceEnabled = false,
  voiceVolume = 1,
  videoName,
}: Props) {
  const [phase, setPhase] = useState<Phase>('loading')
  const [elapsed, setElapsed] = useState(0)
  const [errorMsg, setErrorMsg] = useState('')
  const [reviewMirrored, setReviewMirrored] = useState(false)
  const [recordedMirror, setRecordedMirror] = useState(mirror)

  // Playback speed is owned by the control bar (store) — the comparison simply
  // records at whatever speed the learner picked on the slider.
  const playbackRate = useLessonStore((s) => s.playbackRate)
  const setMirror = useLessonStore((s) => s.setMirror)

  const cameraRef = useRef<HTMLVideoElement | null>(null)
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const streamRef = useRef<MediaStream | null>(null)
  const recorderRef = useRef<MediaRecorder | null>(null)
  const rafRef = useRef<number | null>(null)
  const timerRef = useRef<number | null>(null)
  const chunksRef = useRef<Blob[]>([])
  const urlRef = useRef<string | null>(null)
  const startTsRef = useRef<number>(0)
  const audioMixCleanupRef = useRef<(() => void) | null>(null)
  const isRecordingRef = useRef(false)
  const recordingMirrorRef = useRef(mirror)

  // Refs mirroring mutable values so stable callbacks read fresh data.
  const segRef = useRef<Segment | null>(segment)
  segRef.current = segment
  // The mirror toggle now lives on the ALWAYS-VISIBLE control bar, so it can
  // flip while the rAF draw loop is already running. Reading it through a ref
  // (instead of closing over the prop) keeps the loop honest without having to
  // tear it down and restart it on every toggle.
  const mirrorRef = useRef(mirror)
  mirrorRef.current = mirror
  const beatRef = useRef({ beatIndex, pulse, beatMirror })
  beatRef.current = { beatIndex, pulse, beatMirror }

  // ---- stop helpers --------------------------------------------------------
  const stopRecorder = useCallback(() => {
    const rec = recorderRef.current
    if (rec && rec.state !== 'inactive') {
      try {
        rec.stop()
      } catch {
        /* already stopped */
      }
    }
  }, [])

  const stopLive = useCallback(() => {
    if (rafRef.current != null) {
      cancelAnimationFrame(rafRef.current)
      rafRef.current = null
    }
    if (timerRef.current != null) {
      clearInterval(timerRef.current)
      timerRef.current = null
    }
    const tv = teacherVideoRef.current
    if (tv) tv.pause()
  }, [teacherVideoRef])

  const stopEverything = useCallback(() => {
    stopLive()
    stopRecorder()
    recorderRef.current = null
    const cam = cameraRef.current
    if (cam && cam.srcObject) {
      ;(cam.srcObject as MediaStream).getTracks().forEach((t) => t.stop())
      cam.srcObject = null
    }
    // Also stop the tracks through our own handle: this panel is unmounted when
    // the learner leaves compare mode, so by the time the effect cleanup runs
    // `cameraRef.current` may already be null — without this the camera would
    // keep its indicator light on.
    streamRef.current?.getTracks().forEach((t) => t.stop())
    streamRef.current = null
    audioMixCleanupRef.current?.()
    audioMixCleanupRef.current = null
    isRecordingRef.current = false
    // NOTE: the teacher <video> belongs to the PAGE (it is the main player), so
    // we only pause it above. Clearing its `src`/calling load() here — as the
    // old modal-owned teacher video did — would tear down the main player.
  }, [stopLive, stopRecorder])

  // Continuous side-by-side preview (runs while the panel is open).
  //
  // NOTE: recording is NOT bounded by the segment any more — the learner drills
  // a phrase over and over and stops when THEY are done, so this loop only
  // paints. (The old per-frame `maybeStop()` auto-stop check, and its
  // `timeupdate` twin in start/stopRecording, were removed together.)
  const draw = useCallback(() => {
    const canvas = canvasRef.current
    const tv = teacherVideoRef.current
    const cam = cameraRef.current
    const ctx = canvas?.getContext('2d')
    if (ctx && tv && cam) {
      ctx.fillStyle = '#000'
      ctx.fillRect(0, 0, CANVAS_W, CANVAS_H)
      const frameMirror = isRecordingRef.current
        ? recordingMirrorRef.current
        : mirrorRef.current
      drawHalf(ctx, tv, 0, frameMirror)
      drawHalf(ctx, cam, HALF_W, frameMirror)
      ctx.fillStyle = 'rgba(255,255,255,0.9)'
      ctx.font = 'bold 30px sans-serif'
      ctx.fillText('老师', 24, 44)
      ctx.fillText('我', HALF_W + 24, 44)
      drawBeatOverlay(
        ctx,
        beatRef.current.beatIndex,
        beatRef.current.pulse,
        beatRef.current.beatMirror,
      )
    }
    rafRef.current = requestAnimationFrame(draw)
  }, [teacherVideoRef])

  // ---- start / stop recording ---------------------------------------------
  const startRecording = useCallback(async () => {
    const tv = teacherVideoRef.current
    const canvas = canvasRef.current
    if (!tv || !canvas || !segRef.current) return

    let canvasStream: MediaStream
    try {
      canvasStream = (canvas as HTMLCanvasElement & {
        captureStream: (fps?: number) => MediaStream
      }).captureStream(30)
    } catch {
      setErrorMsg('当前浏览器不支持 canvas 录制（captureStream 不可用）')
      setPhase('unsupported')
      return
    }

    // One Web Audio destination mixes the teacher track with the exact same
    // 1–8 samples heard during practice, so the downloaded file keeps both.
    audioMixCleanupRef.current?.()
    audioMixCleanupRef.current = null
    try {
      const audioMix = await prepareComparisonAudio(tv)
      if (audioMix) {
        canvasStream.addTrack(audioMix.track)
        audioMixCleanupRef.current = audioMix.cleanup
      }
    } catch {
      // Audio is additive: a browser audio-capture failure must not block the
      // learner from recording the visual comparison.
    }

    const mime = pickMimeType()
    let rec: MediaRecorder
    try {
      rec = mime
        ? new MediaRecorder(canvasStream, { mimeType: mime })
        : new MediaRecorder(canvasStream)
    } catch {
      audioMixCleanupRef.current?.()
      audioMixCleanupRef.current = null
      setErrorMsg('当前浏览器不支持 MediaRecorder')
      setPhase('unsupported')
      return
    }

    chunksRef.current = []
    rec.ondataavailable = (e) => {
      if (e.data && e.data.size > 0) chunksRef.current.push(e.data)
    }
    rec.onstop = () => {
      isRecordingRef.current = false
      audioMixCleanupRef.current?.()
      audioMixCleanupRef.current = null
      const blob = new Blob(chunksRef.current, {
        type: rec.mimeType || 'video/webm',
      })
      if (urlRef.current) URL.revokeObjectURL(urlRef.current)
      urlRef.current = URL.createObjectURL(blob)
      stopLive()
      setPhase('review')
    }
    recorderRef.current = rec

    recordingMirrorRef.current = mirrorRef.current
    isRecordingRef.current = true
    setRecordedMirror(recordingMirrorRef.current)
    setReviewMirrored(false)
    tv.currentTime = segRef.current.startTime
    // Record at the speed selected on the control-bar slider (shared store).
    tv.playbackRate = playbackRate
    // Start MediaRecorder before playback so the first count after the seek is
    // present in the file instead of escaping during play() startup.
    rec.start()
    if (voiceEnabled) {
      // Seeking to a bar that is already displaying its first beat does not
      // change LessonPage's beatIndex, so its normal effect would not replay
      // that first count. Trigger it explicitly after MediaRecorder starts.
      void playCountVoice(segRef.current.startBeat ?? 1, voiceVolume)
    }
    startTsRef.current = Date.now()
    setElapsed(0)
    setPhase('recording')
    try {
      await tv.play()
    } catch {
      /* autoplay hiccup — ignore */
    }
    // Tick the on-canvas "录制中 · x.xs" badge. Wall-clock elapsed (not the
    // teacher's `currentTime`) is what the learner cares about, and it stays
    // honest at any playbackRate. `stopLive` clears this interval on every exit
    // path (manual stop, panel close, unmount).
    timerRef.current = window.setInterval(
      () => setElapsed((Date.now() - startTsRef.current) / 1000),
      100,
    )
  }, [playbackRate, stopLive, teacherVideoRef, voiceEnabled, voiceVolume])

  /**
   * Stop the recording. This is the ONLY way a recording ends: it runs for as
   * long as the learner keeps drilling (across segment boundaries, loops and
   * however many repetitions they want) until they press 「停止录制」.
   */
  const stopRecording = useCallback(() => {
    stopRecorder()
  }, [stopRecorder])

  const reRecord = useCallback(() => {
    if (urlRef.current) {
      URL.revokeObjectURL(urlRef.current)
      urlRef.current = null
    }
    chunksRef.current = []
    setReviewMirrored(false)
    const tv = teacherVideoRef.current
    if (tv) {
      tv.currentTime = segRef.current?.startTime ?? 0
      tv.pause()
    }
    setElapsed(0)
    setPhase('ready')
    rafRef.current = requestAnimationFrame(draw)
  }, [draw, teacherVideoRef])

  // ---- camera acquisition (while the panel is open) ------------------------
  useEffect(() => {
    if (!open) return
    setPhase('loading')
    setErrorMsg('')
    setElapsed(0)

    const supported =
      !!navigator.mediaDevices?.getUserMedia &&
      typeof MediaRecorder !== 'undefined' &&
      typeof HTMLCanvasElement.prototype.captureStream === 'function'
    if (!supported) {
      setPhase('unsupported')
      return
    }

    let cancelled = false
    navigator.mediaDevices
      .getUserMedia({
        video: {
          facingMode: 'user',
          width: { ideal: 1280 },
          height: { ideal: 720 },
        },
        audio: false,
      })
      .then((stream) => {
        if (cancelled) {
          stream.getTracks().forEach((t) => t.stop())
          return
        }
        streamRef.current = stream
        const cam = cameraRef.current
        if (cam) {
          cam.srcObject = stream
          void cam.play().catch(() => undefined)
        }
        // The teacher element is the page's own player and already carries
        // `src` — just park its playhead at the start of the segment we are
        // about to compare (the control bar can move it again at any time).
        const tv = teacherVideoRef.current
        if (tv) {
          const parkAtSegmentStart = () => {
            tv.currentTime = segRef.current?.startTime ?? 0
            tv.pause()
          }
          if (tv.readyState >= 1) parkAtSegmentStart()
          else tv.addEventListener('loadedmetadata', parkAtSegmentStart, { once: true })
        }
        setPhase('ready')
        rafRef.current = requestAnimationFrame(draw)
      })
      .catch((err: unknown) => {
        if (cancelled) return
        const name = (err as { name?: string })?.name
        const message = (err as { message?: string })?.message ?? String(err)
        setErrorMsg(
          name === 'NotAllowedError'
            ? '摄像头权限被拒绝，请在浏览器地址栏允许摄像头后重试'
            : `无法访问摄像头：${message}`,
        )
        setPhase('denied')
      })

    return () => {
      cancelled = true
      stopEverything()
      if (urlRef.current) {
        URL.revokeObjectURL(urlRef.current)
        urlRef.current = null
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, src])

  const handleClose = useCallback(() => {
    stopEverything()
    if (urlRef.current) {
      URL.revokeObjectURL(urlRef.current)
      urlRef.current = null
    }
    onClose()
  }, [onClose, stopEverything])

  const statusText =
    phase === 'loading'
      ? '正在打开摄像头…'
      : phase === 'denied'
        ? errorMsg
        : '当前浏览器不支持摄像头录制（需要 getUserMedia + MediaRecorder + canvas.captureStream）。请用最新版 Chrome/Edge 打开本页。'
  const statusColor =
    phase === 'denied' ? 'error.main' : phase === 'unsupported' ? 'warning.main' : 'common.white'

  return (
    <Box
      data-testid="compare-panel"
      sx={{
        border: 1,
        borderColor: 'divider',
        borderRadius: 3,
        p: { xs: 1.5, md: 2 },
        bgcolor: 'background.paper',
      }}
    >
      <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, mb: 1.5 }}>
        <VideocamIcon color="secondary" />
        <Typography variant="subtitle1" sx={{ fontWeight: 600, whiteSpace: 'nowrap' }}>
          对照练习 · 小节 {segmentIndex}
        </Typography>
        <Typography
          variant="caption"
          color="text.secondary"
          sx={{ display: { xs: 'none', md: 'block' } }}
        >
          左：老师 / 右：我 —— 下方控制条照常驱动老师视频
        </Typography>
        <IconButton
          onClick={handleClose}
          sx={{ ml: 'auto' }}
          aria-label="退出对照"
          size="small"
        >
          <CloseIcon />
        </IconButton>
      </Box>

      <Box
        sx={{
          position: 'relative',
          width: '100%',
          aspectRatio: '16 / 9',
          bgcolor: '#000',
          borderRadius: 2,
          overflow: 'hidden',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
        }}
      >
        {(phase === 'ready' || phase === 'recording') && (
          <>
            <canvas
              ref={canvasRef}
              width={CANVAS_W}
              height={CANVAS_H}
              data-testid="compare-canvas"
              style={{ width: '100%', height: '100%', objectFit: 'contain' }}
            />
            {phase === 'recording' && (
              <Box
                sx={{
                  position: 'absolute',
                  top: 12,
                  left: 12,
                  display: 'flex',
                  alignItems: 'center',
                  gap: 1,
                  color: 'common.white',
                  bgcolor: 'rgba(0,0,0,0.45)',
                  px: 1.5,
                  py: 0.5,
                  borderRadius: 1,
                }}
              >
                <FiberManualRecordIcon sx={{ color: 'red', fontSize: 16 }} />
                <Typography variant="body2">
                  录制中 · {elapsed.toFixed(1)}s
                </Typography>
              </Box>
            )}
          </>
        )}

        {phase === 'review' && urlRef.current && (
          <video
            src={urlRef.current}
            controls
            data-testid="review-video"
            className={reviewMirrored ? 'review-video--mirrored' : undefined}
            style={{
              width: '100%',
              height: '100%',
              objectFit: 'contain',
              transform: reviewMirrored ? 'scaleX(-1)' : 'none',
            }}
          />
        )}

        {(phase === 'loading' || phase === 'denied' || phase === 'unsupported') && (
          <Typography sx={{ px: 3, textAlign: 'center', color: statusColor }}>
            {statusText}
          </Typography>
        )}
      </Box>

      <Stack
        direction="row"
        spacing={1}
        alignItems="center"
        flexWrap="wrap"
        useFlexGap
        sx={{ mt: 1.5 }}
      >
        {phase === 'ready' && (
          <>
            <Button
              variant="contained"
              startIcon={<FiberManualRecordIcon />}
              onClick={() => void startRecording()}
            >
              开始录制
            </Button>
            <Button
              variant={mirror ? 'contained' : 'outlined'}
              startIcon={<FlipIcon />}
              onClick={() => setMirror(!mirror)}
            >
              录制镜像
            </Button>
          </>
        )}
        {phase === 'recording' && (
          <Button
            variant="contained"
            color="error"
            startIcon={<StopIcon />}
            onClick={stopRecording}
          >
            停止录制
          </Button>
        )}
        {phase === 'review' && (
          <>
            <Button
              component="a"
              href={urlRef.current ?? undefined}
              download={compareFileName(videoName, segmentIndex)}
              startIcon={<DownloadIcon />}
              variant="contained"
            >
              下载对比视频
            </Button>
            <Button startIcon={<ReplayIcon />} variant="outlined" onClick={reRecord}>
              重新录制
            </Button>
            <Button
              startIcon={<FlipIcon />}
              variant={reviewMirrored ? 'contained' : 'outlined'}
              onClick={() => setReviewMirrored((value) => !value)}
            >
              回看镜像
            </Button>
            <Typography variant="caption" color="text.secondary">
              下载文件：录制镜像{recordedMirror ? '已开启' : '未开启'}
            </Typography>
          </>
        )}
        {phase === 'ready' && (
          <Tooltip title="从本小节开头播放，之后不会自动停止：可以反复练很多遍、跨小节循环，直到你点「停止录制」为止；速度用下方控制条的滑条调整">
            <Typography variant="caption" color="text.secondary">
              持续录制 · 当前 {playbackRate.toFixed(2)}x 倍速 · 手动停止
            </Typography>
          </Tooltip>
        )}
        <Button onClick={handleClose} color="inherit" sx={{ ml: 'auto' }}>
          退出对照
        </Button>
      </Stack>

      {/* Hidden camera source (the teacher source is the page's own player). */}
      <video ref={cameraRef} style={{ display: 'none' }} playsInline muted />
    </Box>
  )
}
