import { useEffect, useMemo, useRef, useState } from 'react'
import { useLocation, useNavigate, useParams } from 'react-router-dom'
import {
  Box,
  Button,
  Container,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  Snackbar,
  TextField,
  Typography,
} from '@mui/material'
import apiClient, { extractApiError } from '../api/client'
import { useVideoControls } from '../hooks/useVideoControls'
import { useBeatSync } from '../hooks/useBeatSync'
import { usePlayPauseSync } from '../hooks/usePlayPauseSync'
import { useLocalProgress, type LessonProgress } from '../hooks/useLocalProgress'
import { useLessonStore } from '../store/lessonStore'
import VideoPlayer from '../components/VideoPlayer'
import SegmentList from '../components/SegmentList'
import ControlBar from '../components/ControlBar'
import ProgressHeader from '../components/ProgressHeader'
import { resegmentSegments, findBeatAt } from '../utils/segmentMath'
import { pickChineseVoice } from '../utils/voice'
import type { AnalysisResult, RecomputeMode } from '../types/api'

const CHINESE_NUM = ['零', '一', '二', '三', '四', '五', '六', '七', '八', '九', '十']

export default function LessonPage() {
  const { taskId } = useParams<{ taskId: string }>()
  const location = useLocation()
  const navigate = useNavigate()
  const videoId: string =
    (location.state as { videoId?: string } | null)?.videoId ?? taskId ?? ''

  const { videoRef, play, togglePlay, seek, setRate } = useVideoControls()
  const { ready, getCourse, saveCourse, updateProgress, markLearned } = useLocalProgress()

  const [result, setResult] = useState<AnalysisResult | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [lowConfOpen, setLowConfOpen] = useState(false)
  const [firstBeat, setFirstBeat] = useState('0')
  const [snack, setSnack] = useState<string | null>(null)
  const [playing, setPlaying] = useState(false)

  const currentSegment = useLessonStore((s) => s.currentSegment)
  const playbackRate = useLessonStore((s) => s.playbackRate)
  const mirror = useLessonStore((s) => s.mirror)
  const loopSegment = useLessonStore((s) => s.loopSegment)
  const voiceEnabled = useLessonStore((s) => s.voiceEnabled)
  const beatOffset = useLessonStore((s) => s.beatOffset)
  const abLoop = useLessonStore((s) => s.abLoop)
  const setABLoop = useLessonStore((s) => s.setABLoop)
  const learnedSegments = useLessonStore((s) => s.learnedSegments)
  const setSegment = useLessonStore((s) => s.setSegment)
  const setLearnedSegments = useLessonStore((s) => s.setLearnedSegments)

  const segments = result?.segments ?? []

  // Re-cut the phrase grid so segment boundaries follow the manual beat
  // offset (Bug: "拍点偏移后小节分段不跟随平移"). Every consumer below reads
  // `offsetSegments`, not the raw `segments`, so the list, the active-segment
  // highlight, the loop target, and the seek targets all share the same shifted
  // grid. `beatOffset = 0` then makes the on-screen 1..8 count line up with each
  // phrase — passing the non-zero `beatOffset` here would double-apply the shift
  // (the offset is already baked into `offsetSegments`). `segments` itself is
  // preserved untouched, so resetting the slider to 0 restores the original grid.
  const offsetSegments = useMemo(
    () => resegmentSegments(segments, beatOffset),
    [segments, beatOffset],
  )

  const beatDuration =
    segments.length > 0
      ? segments.reduce((a, s) => a + (s.endTime - s.startTime), 0) /
        segments.reduce((a, s) => a + s.beats.length, 0)
      : 0
  const { beatIndex, pulse } = useBeatSync(
    videoRef,
    offsetSegments,
    loopSegment,
    0,
    beatDuration,
    (i) => setSegment(i),
    abLoop,
  )

  // Fetch result + hydrate progress from local storage.
  useEffect(() => {
    if (!taskId) return
    let cancelled = false
    void (async () => {
      try {
        const res = await apiClient.getResult(taskId)
        if (cancelled) return
        setResult(res)
        if (ready) {
          const course = getCourse(videoId)
          if (course) {
            const p: LessonProgress = course.progress
            useLessonStore.setState({
              currentSegment: p.currentSegment,
              playbackRate: p.playbackRate,
              mirror: p.mirror,
              loopSegment: p.loopSegment,
              voiceEnabled: p.voiceEnabled,
              beatOffset: p.beatOffset ?? 0,
              learnedSegments: p.learnedSegments,
              abLoop: p.abLoop ?? null,
            })
          } else {
            await saveCourse(videoId, {
              videoName: res.videoName,
              taskId: res.taskId,
              result: res,
              progress: {
                currentSegment: 1,
                playbackRate: 1,
                mirror: true,
                loopSegment: false,
                voiceEnabled: false,
                beatOffset: 0,
                learnedSegments: [],
                abLoop: null,
                updatedAt: new Date().toISOString(),
              },
            })
          }
        }
        if (res.beatLowConfidence) setLowConfOpen(true)
      } catch (e) {
        if (!cancelled) setError(extractApiError(e).message)
      } finally {
        if (!cancelled) setLoading(false)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [taskId, videoId, ready, getCourse, saveCourse])

  // Track real play/pause state for the control-bar icon. `usePlayPauseSync`
  // re-attaches its `play`/`pause` listeners when `segments` flips from `[]`
  // to the real array — which is the same render that mounts the <video> — so
  // the icon starts tracking the moment the element exists. See the hook for
  // the detailed Bug-C explanation.
  usePlayPauseSync(videoRef, segments, setPlaying)

  // Apply playback rate to the element whenever it changes.
  useEffect(() => {
    setRate(playbackRate)
  }, [playbackRate, setRate])

  // Resume at the saved segment once on load (waits for metadata to seek).
  const didInit = useRef(false)
  useEffect(() => {
    if (!result || !ready || didInit.current) return
    const v = videoRef.current
    if (!v) return
    const seg =
      offsetSegments.find((s) => s.index === currentSegment) ?? offsetSegments[0]
    if (!seg) return
    const doSeek = () => {
      seek(seg.startTime)
      didInit.current = true
    }
    if (v.readyState >= 1) doSeek()
    else v.addEventListener('loadedmetadata', doSeek, { once: true })
  }, [result, ready, currentSegment, offsetSegments, seek, videoRef])

  // Persist progress on any relevant change (breakpoint resume, P0-9).
  useEffect(() => {
    if (!ready || !videoId || !result) return
    void updateProgress(videoId, {
      currentSegment,
      playbackRate,
      mirror,
      loopSegment,
      voiceEnabled,
      beatOffset,
      learnedSegments,
      abLoop,
    })
  }, [
    ready,
    videoId,
    result,
    currentSegment,
    playbackRate,
    mirror,
    loopSegment,
    voiceEnabled,
    beatOffset,
    learnedSegments,
    abLoop,
    updateProgress,
  ])

  // Cache the available TTS voices. In some browsers `getVoices()` returns an
  // empty array on the first call and populates asynchronously, firing the
  // `voiceschanged` event when ready — so we listen and refresh the cache.
  const voicesRef = useRef<SpeechSynthesisVoice[]>([])
  useEffect(() => {
    if (!('speechSynthesis' in window)) return
    const sync = () => {
      voicesRef.current = window.speechSynthesis.getVoices()
    }
    sync()
    window.speechSynthesis.addEventListener('voiceschanged', sync)
    return () => {
      window.speechSynthesis.removeEventListener('voiceschanged', sync)
    }
  }, [])

  // Optional voice count (P1-1 preview): speak the current beat in Chinese using
  // the most natural available Chinese voice (cached above). A slower rate and a
  // slightly higher pitch read more clearly than the previous robotic default.
  useEffect(() => {
    if (voiceEnabled && beatIndex > 0 && 'speechSynthesis' in window) {
      const u = new SpeechSynthesisUtterance(CHINESE_NUM[beatIndex] ?? String(beatIndex))
      const voice = pickChineseVoice(voicesRef.current)
      if (voice) u.voice = voice
      u.lang = voice?.lang ?? 'zh-CN'
      u.rate = 1.15
      u.pitch = 1.08
      window.speechSynthesis.cancel()
      window.speechSynthesis.speak(u)
    }
  }, [beatIndex, voiceEnabled])

  const goToSegment = (index: number) => {
    const seg = offsetSegments.find((s) => s.index === index)
    if (!seg) return
    setSegment(index)
    setRate(playbackRate)
    seek(seg.startTime)
    play()
  }

  const handlePrev = () => {
    if (currentSegment > 1) goToSegment(currentSegment - 1)
  }
  const handleNext = () => {
    if (currentSegment < offsetSegments.length) goToSegment(currentSegment + 1)
  }

  // ---- Custom A→B loop (beat-anchored) ---------------------------------
  // Anchor each point on the most recent beat at or before the current play
  // position (so the loop seam lines up with the music). A and B are stored as
  // beat times; enabling the loop is mutually exclusive with single-segment
  // looping (enforced in the store).
  const handleSetAB = (which: 'a' | 'b') => {
    const v = videoRef.current
    if (!v) return
    const hit = findBeatAt(offsetSegments, v.currentTime)
    if (!hit) return
    const prev = useLessonStore.getState().abLoop
    if (which === 'a') {
      setABLoop({
        enabled: prev?.enabled ?? false,
        aTime: hit.beatTime,
        bTime: prev?.bTime ?? hit.beatTime,
        aBeat: hit.globalBeat,
        bBeat: prev?.bBeat ?? hit.globalBeat,
      })
    } else {
      setABLoop({
        enabled: prev?.enabled ?? false,
        aTime: prev?.aTime ?? hit.beatTime,
        bTime: hit.beatTime,
        aBeat: prev?.aBeat ?? hit.globalBeat,
        bBeat: hit.globalBeat,
      })
    }
  }
  const handleEnableAB = () => {
    const cur = useLessonStore.getState().abLoop
    if (!cur || cur.aTime >= cur.bTime) return
    // Store auto-clears loopSegment (mutual exclusivity) when AB is enabled.
    setABLoop({ ...cur, enabled: true })
  }
  const handleDisableAB = () => {
    const cur = useLessonStore.getState().abLoop
    if (!cur) return
    setABLoop({ ...cur, enabled: false })
  }
  const handleClearAB = () => setABLoop(null)

  const handleMarkLearned = () => {
    const learned = learnedSegments.includes(currentSegment)
    setLearnedSegments(
      learned
        ? learnedSegments.filter((x) => x !== currentSegment)
        : [...learnedSegments, currentSegment].sort((a, b) => a - b),
    )
    void markLearned(videoId, currentSegment, !learned)
  }

  const handleRecompute = async (mode: RecomputeMode) => {
    if (!taskId) return
    try {
      const req: { mode: RecomputeMode; firstBeatTime?: number } = { mode }
      if (mode === 'manual_first_beat') req.firstBeatTime = parseFloat(firstBeat)
      const res = await apiClient.recompute(taskId, req)
      setResult(res)
      setLowConfOpen(false)
      setSnack('已重新生成分段')
    } catch (e) {
      setError(extractApiError(e).message)
    }
  }

  if (loading) {
    return (
      <Container sx={{ py: 10, textAlign: 'center' }}>
        <Typography>加载教学中…</Typography>
      </Container>
    )
  }
  if (error) {
    return (
      <Container sx={{ py: 10, textAlign: 'center' }}>
        <Typography color="error">{error}</Typography>
        <Button sx={{ mt: 2 }} onClick={() => navigate('/')}>
          返回上传
        </Button>
      </Container>
    )
  }
  if (!result) return null

  const total = offsetSegments.length
  const videoSrc = `${apiClient.BASE}/video/${taskId}`

  return (
    <Box sx={{ minHeight: '100vh', pb: 6 }}>
      <ProgressHeader
        videoName={result.videoName}
        current={currentSegment}
        total={total}
        onBack={() => navigate('/progress')}
      />
      <Container maxWidth="xl">
        <Box sx={{ display: 'flex', flexDirection: { xs: 'column', md: 'row' }, gap: 3 }}>
          <Box sx={{ width: { md: 280 }, flexShrink: 0 }}>
            <Typography variant="subtitle2" color="text.secondary" sx={{ mb: 1 }}>
              小节列表（8 拍/节）
            </Typography>
            <SegmentList
              segments={offsetSegments}
              currentSegment={currentSegment}
              learnedSegments={learnedSegments}
              onSelect={goToSegment}
            />
          </Box>
          <Box sx={{ flexGrow: 1 }}>
            <VideoPlayer
              src={videoSrc}
              mirror={mirror}
              videoRef={videoRef}
              beatIndex={beatIndex}
              pulse={pulse}
            />
            <ControlBar
              playing={playing}
              canPrev={currentSegment > 1}
              canNext={currentSegment < total}
              onTogglePlay={togglePlay}
              onPrev={handlePrev}
              onNext={handleNext}
              onMarkLearned={handleMarkLearned}
              learned={learnedSegments.includes(currentSegment)}
              segments={offsetSegments}
              abLoop={abLoop}
              onSetA={() => handleSetAB('a')}
              onSetB={() => handleSetAB('b')}
              onEnableAB={handleEnableAB}
              onDisableAB={handleDisableAB}
              onClearAB={handleClearAB}
            />
          </Box>
        </Box>
      </Container>

      <Dialog open={lowConfOpen} onClose={() => setLowConfOpen(false)}>
        <DialogTitle>节拍置信度较低</DialogTitle>
        <DialogContent>
          <Typography variant="body2" sx={{ mb: 2 }}>
            自动检测的节拍可能不准，请选择一种方式重新生成 8 拍分段：
          </Typography>
          <TextField
            fullWidth
            size="small"
            label="手动第一拍时间（秒）"
            type="number"
            value={firstBeat}
            onChange={(e) => setFirstBeat(e.target.value)}
            sx={{ mb: 1 }}
          />
          <Typography variant="caption" color="text.secondary">
            仅在「手动标第一拍」时使用。
          </Typography>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => handleRecompute('auto')}>自动重算</Button>
          <Button onClick={() => handleRecompute('fixed120')}>固定 120 BPM</Button>
          <Button variant="contained" onClick={() => handleRecompute('manual_first_beat')}>
            手动标第一拍
          </Button>
        </DialogActions>
      </Dialog>

      <Snackbar
        open={!!snack}
        autoHideDuration={2500}
        onClose={() => setSnack(null)}
        message={snack ?? ''}
      />
    </Box>
  )
}
