import { useCallback, useEffect, useMemo, useRef, useState, type MutableRefObject } from 'react'
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
import { getLocalResult, recomputeLocalTask } from '../api/localAnalysis'
import { getVideo } from '../storage/videoRegistry'
import { useVideoControls } from '../hooks/useVideoControls'
import { useBeatSync } from '../hooks/useBeatSync'
import { usePlayPauseSync } from '../hooks/usePlayPauseSync'
import { useLocalProgress, type LessonProgress } from '../hooks/useLocalProgress'
import { useLessonStore } from '../store/lessonStore'
import VideoPlayer from '../components/VideoPlayer'
import SegmentList from '../components/SegmentList'
import ControlBar from '../components/ControlBar'
import CompareMode from '../components/CompareMode'
import ProgressHeader from '../components/ProgressHeader'
import BeatInfoCard from '../components/BeatInfoCard'
import { resegmentSegments, findBeatAt } from '../utils/segmentMath'
import { resolveCompareSegment } from '../utils/compare'
import { pickChineseVoice } from '../utils/voice'
import { DEMO_VIDEO_URL } from '../demo/sampleLesson'
import type { AnalysisResult, RecomputeMode } from '../types/api'

const CHINESE_NUM = ['零', '一', '二', '三', '四', '五', '六', '七', '八', '九', '十']

export default function LessonPage() {
  const { taskId } = useParams<{ taskId: string }>()
  const location = useLocation()
  const navigate = useNavigate()
  const videoId: string =
    (location.state as { videoId?: string } | null)?.videoId ?? taskId ?? ''

  // 「试用示例」模式：UploadPage 通过 navigate state 注入一份内置 AnalysisResult，
  // 此时完全跳过后端 getResult 拉取，直接用 demoResult 作为数据源（见下方 early effect）。
  const demoResult = (location.state as { demoResult?: AnalysisResult } | null)?.demoResult ?? null

  const { videoRef, play, togglePlay, seek, setRate } = useVideoControls()
  const { ready, getCourse, saveCourse, updateProgress, markLearned } = useLocalProgress()

  const [result, setResult] = useState<AnalysisResult | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [recomputing, setRecomputing] = useState(false)
  const [lowConfOpen, setLowConfOpen] = useState(false)
  const [firstBeat, setFirstBeat] = useState('0')
  const [snack, setSnack] = useState<string | null>(null)
  const [playing, setPlaying] = useState(false)
  const [compareOpen, setCompareOpen] = useState(false)
  // Local video source: object URL from the registry / IndexedDB. Null while
  // resolving (or empty string when the blob is unavailable after a reload).
  const [videoSrc, setVideoSrc] = useState<string | null>(
    demoResult ? DEMO_VIDEO_URL : null,
  )

  const currentSegment = useLessonStore((s) => s.currentSegment)
  const playbackRate = useLessonStore((s) => s.playbackRate)
  const mirror = useLessonStore((s) => s.mirror)
  const beatMirror = useLessonStore((s) => s.beatMirror)
  const loopSegment = useLessonStore((s) => s.loopSegment)
  const voiceEnabled = useLessonStore((s) => s.voiceEnabled)
  const beatOffset = useLessonStore((s) => s.beatOffset)
  const draftBeatOffset = useLessonStore((s) => s.draftBeatOffset)
  const loopCount = useLessonStore((s) => s.loopCount)
  const loopMode = useLessonStore((s) => s.loopMode)
  const loopSegmentIds = useLessonStore((s) => s.loopSegmentIds)
  const abLoop = useLessonStore((s) => s.abLoop)
  const setABLoop = useLessonStore((s) => s.setABLoop)
  const learnedSegments = useLessonStore((s) => s.learnedSegments)
  const setSegment = useLessonStore((s) => s.setSegment)
  const setLoopSegment = useLessonStore((s) => s.setLoopSegment)
  const setLearnedSegments = useLessonStore((s) => s.setLearnedSegments)

  const segments = result?.segments ?? []

  // 「试用示例」早返回：demo 模式下直接用注入的 demoResult 作为数据源，
  // 跳过任何后端 fetch（离线静态部署下后端不可用）。一旦 result 已被填充
  // （首次渲染为 null）即不再重复 set，避免死循环。
  useEffect(() => {
    if (demoResult && result === null) {
      setResult(demoResult)
      setLoading(false)
    }
  }, [demoResult, result])

  // Resolve the local video source (object URL from the registry / IndexedDB).
  // Falls back to '' when the file is unavailable (e.g. full reload with no
  // persisted blob) — the UI still renders, only playback is unavailable.
  useEffect(() => {
    if (demoResult) {
      setVideoSrc(DEMO_VIDEO_URL)
      return
    }
    let cancelled = false
    void (async () => {
      const entry = await getVideo(videoId)
      if (!cancelled) setVideoSrc(entry ? entry.url : '')
    })()
    return () => {
      cancelled = true
    }
  }, [videoId, demoResult])

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
  // 单节循环竞态修复：goToSegment 在「单节循环」模式下 seek 之前，先把目标小节
  // index 写入此 ref；useBeatSync 的 tick 在下一帧最开头同步消费，强制把循环目标
  // 切到用户点击的小节，避免播放头被旧循环目标拽回（"卡在当前小节"）。
  // multi 模式不写该 ref（既有 onSeeked re-anchor 已处理），故无副作用。
  const forceLoopTargetRef = useRef<number | null>(null)
  const { beatIndex, pulse, stepBeat } = useBeatSync(
    videoRef,
    offsetSegments,
    loopSegment,
    // 偏移预览：offsetSegments 已按「已应用」beatOffset 切好网格。这里只传入
    // draft 与 applied 的差值，让数拍计数在拖动时实时平移预览，但不重切网格 /
    // 不动循环落点。draft===applied 时差值为 0，计数与网格一致。
    draftBeatOffset - beatOffset,
    beatDuration,
    (i) => setSegment(i),
    abLoop,
    loopCount,
    loopMode,
    loopSegmentIds,
    // Compare-mode hides the player (display:none) but the SAME <video> keeps
    // playing side-by-side — tell the engine to stop driving loop/AB seeks.
    !compareOpen,
    // 单节循环竞态修复：把强制循环目标 ref 传给引擎（详见 forceLoopTargetRef 注释）。
    forceLoopTargetRef as MutableRefObject<number | null>,
  )

  // Hydrate learning progress from the local course store (once the result is
  // ready). Defined as a callback so the effect below can depend on it.
  const hydrateProgress = useCallback(
    (res: AnalysisResult) => {
      if (!ready) return
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
          draftBeatOffset: p.beatOffset ?? 0,
          learnedSegments: p.learnedSegments,
          abLoop: p.abLoop ?? null,
        })
      } else {
        // 新建课程：草稿偏移重置为 0（store 默认值已是 0，这里显式同步，
        // 避免从上一个课程的草稿值残留）。
        useLessonStore.setState({ draftBeatOffset: 0 })
        void saveCourse(videoId, {
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
    },
    [ready, getCourse, saveCourse, videoId],
  )

  // Source the analysis result: demo > in-memory local task > persisted course.
  // No backend is contacted.
  useEffect(() => {
    if (demoResult) return // demo early-effect already set the result
    const local = taskId ? getLocalResult(taskId) : null
    if (local) {
      setResult(local)
      hydrateProgress(local)
      if (local.beatLowConfidence) setLowConfOpen(true)
      setLoading(false)
      return
    }
    if (ready) {
      const course = getCourse(videoId)
      if (course) {
        setResult(course.result)
        hydrateProgress(course.result)
        if (course.result.beatLowConfidence) setLowConfOpen(true)
      } else {
        setError('未找到该视频的分析结果，请重新上传')
      }
      setLoading(false)
    }
  }, [taskId, videoId, ready, demoResult, getCourse, hydrateProgress])

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
    // 「点哪节就循环哪节」：单节循环模式下，点击任意小节会自动开启单节循环并
    // 把循环目标锁到点击的小节。setLoopSegment(true) 幂等（已开启则无副作用），
    // 且会互斥清除 AB loop（store 内保证）。
    // 写入 forceLoopTargetRef 的时机必须在 seek 之前：让 useBeatSync 的 tick 在
    // 下一帧最早时机把循环目标强制切到点击的小节，消除竞态——否则旧目标的
    // padded loopEnd（含 ±1 拍缓冲）可能落在新小节起点之后，tick 误判回跳、把
    // 播放头拽回旧小节（"卡在当前小节"）。该 ref 仅 single 模式被消费。
    // multi 模式维持既有「仅跳转」行为：不自动开启单节循环、也不写该 ref
    // （其循环切换由 onSeeked re-anchor 处理）。
    if (loopMode === 'single') {
      setLoopSegment(true)
      forceLoopTargetRef.current = index
    }
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
    if (taskId === 'demo') {
      setSnack('示例模式：重新计算需上传真实视频')
      return
    }
    try {
      const req: { mode: RecomputeMode; firstBeatTime?: number } = { mode }
      if (mode === 'manual_first_beat') req.firstBeatTime = parseFloat(firstBeat)
      const res = await recomputeLocalTask(taskId, req)
      setResult(res)
      setLowConfOpen(false)
      setSnack('已重新生成分段')
    } catch (e) {
      setError(e instanceof Error ? e.message : '重新计算失败')
    }
  }

  // Manual BPM override (the new "用此 BPM 重算" path). The user types a corrected
  // tempo in the BeatInfoCard; we re-derive the segments at exactly that BPM via
  // the backend's `fixedBpm` mode. `result.bpm` / `result.confidence` are shown
  // by the card from the regular analysis result, independent of beatLowConfidence.
  const handleApplyBpm = async (bpm: number) => {
    if (!taskId) return
    if (taskId === 'demo') {
      setSnack('示例模式：重新计算需上传真实视频')
      return
    }
    setRecomputing(true)
    try {
      const res = await recomputeLocalTask(taskId, { mode: 'fixedBpm', bpm })
      setResult(res)
      setSnack(`已用 BPM ${bpm} 重新生成分段`)
    } catch (e) {
      setError(e instanceof Error ? e.message : '重新计算失败')
    } finally {
      setRecomputing(false)
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

  return (
    <Box sx={{ minHeight: '100vh', pb: 6 }}>
      <ProgressHeader
        videoName={result.videoName}
        current={currentSegment}
        total={total}
        onBack={() => navigate('/progress')}
      />
      <Container maxWidth="xl">
        {/* Persistent beat-info card: detected BPM + confidence, with a manual
            BPM override that re-derives the 8-beat segments at the typed tempo. */}
        <BeatInfoCard
          bpm={result.bpm}
          confidence={result.confidence}
          loading={recomputing}
          onApplyBpm={handleApplyBpm}
        />
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
            {/*
              对照练习 = 原地左右分屏，不再弹窗。
              `VideoPlayer` 始终保持挂载（对照时仅视觉隐藏），这样 `videoRef`
              指向的 <video> 元素在开/关对照时都不会被卸载重建：播放进度、
              倍速、`useBeatSync` / `usePlayPauseSync` 挂在元素上的监听器全部
              原样保留，底部 ControlBar 的每一个按钮都继续驱动同一个老师视频。
              CompareMode 只是把这个元素画进 canvas 左半边而已。
            */}
            <Box sx={{ display: compareOpen ? 'none' : 'block' }}>
              <VideoPlayer
                src={videoSrc ?? ''}
                mirror={mirror}
                beatMirror={beatMirror}
                videoRef={videoRef}
                beatIndex={beatIndex}
                pulse={pulse}
                stepBeat={stepBeat}
                // The overlay dots are 0-based; `Segment.index` (and therefore
                // `goToSegment`) is 1-based, so convert here. `total` makes the
                // dot count equal the number of selectable sections.
                total={offsetSegments.length}
                onDotClick={(i) => goToSegment(i + 1)}
              />
            </Box>
            {compareOpen && (
              <CompareMode
                open={compareOpen}
                onClose={() => setCompareOpen(false)}
                teacherVideoRef={videoRef}
                src={videoSrc ?? ''}
                segment={resolveCompareSegment(offsetSegments, currentSegment)}
                segmentIndex={currentSegment}
                mirror={mirror}
                videoName={result.videoName}
              />
            )}
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
              onCompare={() => setCompareOpen((o) => !o)}
              comparing={compareOpen}
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
