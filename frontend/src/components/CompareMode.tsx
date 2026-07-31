import { useCallback, useEffect, useRef, useState } from 'react'
import {
  Box,
  Button,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
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
import type { Segment } from '../types/api'
import { compareFileName, pickMimeType, shouldAutoStop } from '../utils/compare'

type Phase = 'loading' | 'denied' | 'ready' | 'recording' | 'review' | 'unsupported'

const CANVAS_W = 1280
const CANVAS_H = 720
const HALF_W = CANVAS_W / 2

interface Props {
  open: boolean
  onClose: () => void
  /** Teacher video source URL (same-origin preferred so the canvas isn't tainted). */
  src: string
  /** The segment to record (one 8-beat phrase). */
  segment: Segment | null
  segmentIndex: number
  /** Studio-mirror: applied to BOTH halves so left/right line up for comparison. */
  mirror: boolean
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

export default function CompareMode({
  open,
  onClose,
  src,
  segment,
  segmentIndex,
  mirror,
  videoName,
}: Props) {
  const [phase, setPhase] = useState<Phase>('loading')
  const [rate, setRate] = useState(1)
  const [elapsed, setElapsed] = useState(0)
  const [errorMsg, setErrorMsg] = useState('')

  const teacherRef = useRef<HTMLVideoElement | null>(null)
  const cameraRef = useRef<HTMLVideoElement | null>(null)
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const streamRef = useRef<MediaStream | null>(null)
  const recorderRef = useRef<MediaRecorder | null>(null)
  const rafRef = useRef<number | null>(null)
  const timerRef = useRef<number | null>(null)
  const chunksRef = useRef<Blob[]>([])
  const urlRef = useRef<string | null>(null)
  const startTsRef = useRef<number>(0)

  // Refs mirroring mutable values so stable callbacks read fresh data.
  const phaseRef = useRef<Phase>('loading')
  const segRef = useRef<Segment | null>(segment)
  segRef.current = segment

  useEffect(() => {
    phaseRef.current = phase
  }, [phase])

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
    const tv = teacherRef.current
    if (tv) tv.pause()
  }, [])

  const stopEverything = useCallback(() => {
    stopLive()
    stopRecorder()
    recorderRef.current = null
    const cam = cameraRef.current
    if (cam && cam.srcObject) {
      ;(cam.srcObject as MediaStream).getTracks().forEach((t) => t.stop())
      cam.srcObject = null
    }
    streamRef.current = null
    const tv = teacherRef.current
    if (tv) {
      tv.pause()
      tv.removeAttribute('src')
      tv.load()
    }
  }, [stopLive, stopRecorder])

  // Auto-stop when the teacher playhead reaches the segment end.
  const maybeStop = useCallback(() => {
    const tv = teacherRef.current
    if (phaseRef.current !== 'recording' || !tv) return
    const end = segRef.current?.endTime ?? 0
    if (shouldAutoStop(tv.currentTime, end)) stopRecorder()
  }, [stopRecorder])

  // Continuous preview + auto-stop check (runs while modal is open).
  const draw = useCallback(() => {
    const canvas = canvasRef.current
    const tv = teacherRef.current
    const cam = cameraRef.current
    const ctx = canvas?.getContext('2d')
    if (ctx && tv && cam) {
      ctx.fillStyle = '#000'
      ctx.fillRect(0, 0, CANVAS_W, CANVAS_H)
      drawHalf(ctx, tv, 0, mirror)
      drawHalf(ctx, cam, HALF_W, mirror)
      ctx.fillStyle = 'rgba(255,255,255,0.9)'
      ctx.font = 'bold 30px sans-serif'
      ctx.fillText('老师', 24, 44)
      ctx.fillText('我', HALF_W + 24, 44)
    }
    maybeStop()
    rafRef.current = requestAnimationFrame(draw)
  }, [mirror, maybeStop])

  // ---- start / stop recording ---------------------------------------------
  const startRecording = useCallback(async () => {
    const tv = teacherRef.current
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

    // Mix the teacher's audio track into the recording (camera has no audio).
    try {
      const teacherStream = (
        tv as HTMLVideoElement & { captureStream?: () => MediaStream }
      ).captureStream?.()
      const audioTrack = teacherStream?.getAudioTracks?.()[0]
      if (audioTrack) canvasStream.addTrack(audioTrack)
    } catch {
      /* video-only fallback */
    }

    const mime = pickMimeType()
    let rec: MediaRecorder
    try {
      rec = mime
        ? new MediaRecorder(canvasStream, { mimeType: mime })
        : new MediaRecorder(canvasStream)
    } catch {
      setErrorMsg('当前浏览器不支持 MediaRecorder')
      setPhase('unsupported')
      return
    }

    chunksRef.current = []
    rec.ondataavailable = (e) => {
      if (e.data && e.data.size > 0) chunksRef.current.push(e.data)
    }
    rec.onstop = () => {
      const blob = new Blob(chunksRef.current, {
        type: rec.mimeType || 'video/webm',
      })
      if (urlRef.current) URL.revokeObjectURL(urlRef.current)
      urlRef.current = URL.createObjectURL(blob)
      stopLive()
      setPhase('review')
    }
    recorderRef.current = rec

    tv.currentTime = segRef.current.startTime
    tv.playbackRate = rate
    tv.addEventListener('timeupdate', maybeStop)
    try {
      await tv.play()
    } catch {
      /* autoplay hiccup — ignore */
    }
    rec.start()
    startTsRef.current = Date.now()
    setElapsed(0)
    phaseRef.current = 'recording'
    setPhase('recording')
  }, [maybeStop, rate, stopLive])

  const stopRecording = useCallback(() => {
    const tv = teacherRef.current
    if (tv) tv.removeEventListener('timeupdate', maybeStop)
    stopRecorder()
  }, [maybeStop, stopRecorder])

  const reRecord = useCallback(() => {
    if (urlRef.current) {
      URL.revokeObjectURL(urlRef.current)
      urlRef.current = null
    }
    chunksRef.current = []
    const tv = teacherRef.current
    if (tv) {
      tv.currentTime = segRef.current?.startTime ?? 0
      tv.pause()
    }
    setElapsed(0)
    phaseRef.current = 'ready'
    setPhase('ready')
    rafRef.current = requestAnimationFrame(draw)
  }, [draw])

  // ---- camera acquisition (on open) ---------------------------------------
  useEffect(() => {
    if (!open) return
    setPhase('loading')
    setErrorMsg('')
    setElapsed(0)
    setRate(1)

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
        const tv = teacherRef.current
        if (tv) {
          tv.src = src
          tv.muted = false
          const onMeta = () => {
            tv.currentTime = segRef.current?.startTime ?? 0
            tv.pause()
          }
          tv.addEventListener('loadedmetadata', onMeta, { once: true })
          tv.load()
        }
        phaseRef.current = 'ready'
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
      phaseRef.current = 'loading'
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

  const speeds = [
    { label: '0.5x', value: 0.5 },
    { label: '0.75x', value: 0.75 },
    { label: '1x', value: 1 },
  ]

  return (
    <Dialog open={open} onClose={handleClose} maxWidth="md" fullWidth>
      <DialogTitle sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
        <VideocamIcon />
        对照练习 · 小节 {segmentIndex}
        <IconButton
          onClick={handleClose}
          sx={{ ml: 'auto' }}
          aria-label="关闭"
          size="small"
        >
          <CloseIcon />
        </IconButton>
      </DialogTitle>

      <DialogContent>
        {phase === 'loading' && (
          <Typography>正在打开摄像头…</Typography>
        )}
        {phase === 'denied' && (
          <Typography color="error">{errorMsg}</Typography>
        )}
        {phase === 'unsupported' && (
          <Typography color="warning.main">
            当前浏览器不支持摄像头录制（需要 getUserMedia + MediaRecorder +
            canvas.captureStream）。请用最新版 Chrome/Edge 打开本页。
          </Typography>
        )}

        {(phase === 'ready' || phase === 'recording') && (
          <>
            <Box
              sx={{
                position: 'relative',
                width: '100%',
                aspectRatio: '16 / 9',
                bgcolor: '#000',
                borderRadius: 2,
                overflow: 'hidden',
              }}
            >
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
            </Box>

            {phase === 'ready' && (
              <Stack
                direction="row"
                spacing={1}
                alignItems="center"
                sx={{ mt: 2 }}
              >
                <Typography variant="body2" color="text.secondary">
                  对照速度
                </Typography>
                {speeds.map((s) => (
                  <Button
                    key={s.value}
                    size="small"
                    variant={rate === s.value ? 'contained' : 'outlined'}
                    onClick={() => {
                      setRate(s.value)
                      const tv = teacherRef.current
                      if (tv) tv.playbackRate = s.value
                    }}
                  >
                    {s.label}
                  </Button>
                ))}
                <Tooltip title="从本小节开头播放，到本小节结束自动停止录制">
                  <Typography variant="caption" color="text.secondary">
                    一小节结束自动停
                  </Typography>
                </Tooltip>
              </Stack>
            )}
          </>
        )}

        {phase === 'review' && urlRef.current && (
          <Box
            sx={{
              width: '100%',
              aspectRatio: '16 / 9',
              bgcolor: '#000',
              borderRadius: 2,
              overflow: 'hidden',
            }}
          >
            <video
              src={urlRef.current}
              controls
              data-testid="review-video"
              style={{ width: '100%', height: '100%', objectFit: 'contain' }}
            />
          </Box>
        )}

        {/* Hidden source videos (kept mounted so refs persist). */}
        <video
          ref={teacherRef}
          data-testid="teacher-video"
          style={{ display: 'none' }}
          playsInline
        />
        <video
          ref={cameraRef}
          style={{ display: 'none' }}
          playsInline
          muted
        />
      </DialogContent>

      <DialogActions sx={{ px: 3, pb: 2 }}>
        {phase === 'ready' && (
          <Button
            variant="contained"
            startIcon={<FiberManualRecordIcon />}
            onClick={() => void startRecording()}
          >
            开始录制
          </Button>
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
            <Button
              startIcon={<ReplayIcon />}
              variant="outlined"
              onClick={reRecord}
            >
              重新录制
            </Button>
          </>
        )}
        <Button onClick={handleClose} color="inherit">
          关闭
        </Button>
      </DialogActions>
    </Dialog>
  )
}
