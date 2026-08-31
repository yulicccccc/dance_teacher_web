import {
  Box,
  Button,
  FormControlLabel,
  IconButton,
  Slider,
  Stack,
  Switch,
  ToggleButton,
  ToggleButtonGroup,
  Tooltip,
  Typography,
} from '@mui/material'
import PlayArrowIcon from '@mui/icons-material/PlayArrow'
import PauseIcon from '@mui/icons-material/Pause'
import SkipNextIcon from '@mui/icons-material/SkipNext'
import SkipPreviousIcon from '@mui/icons-material/SkipPrevious'
import ReplayIcon from '@mui/icons-material/Replay'
import FlipIcon from '@mui/icons-material/Flip'
import RecordVoiceOverIcon from '@mui/icons-material/RecordVoiceOver'
import VideocamIcon from '@mui/icons-material/Videocam'
import VideocamOffIcon from '@mui/icons-material/VideocamOff'
import KeyboardIcon from '@mui/icons-material/Keyboard'
import MusicNoteIcon from '@mui/icons-material/MusicNote'
import { useLessonStore, type LoopMode } from '../store/lessonStore'
import { findBeatAt } from '../utils/segmentMath'
import { formatDuration } from '../utils/format'
import type { Segment, ABLoop } from '../types/api'
import {
  unlockCountVoiceAudio,
  unlockMetronomeAudio,
  type MetronomeSound,
} from '../audio/countVoiceAudio'
import type { MetronomeRate } from '../audio/metronomeTiming'

interface Props {
  playing: boolean
  canPrev: boolean
  canNext: boolean
  currentSegment: number
  currentTime: number
  duration: number
  onSeekTime: (time: number) => void
  onTogglePlay: () => void
  onPrev: () => void
  onNext: () => void
  onMarkLearned: () => void
  learned: boolean
  segments: Segment[]
  onSetA: () => void
  onSetB: () => void
  onClearAB: () => void
  onCompare: () => void
  comparing?: boolean
  onConfirmBeatOffset?: (offset: number) => void
  onShowShortcuts?: () => void
}

function formatABPoint(
  label: string,
  ab: ABLoop | null,
  which: 'a' | 'b',
  segments: Segment[],
): string {
  if (!ab) return `${label}: —`
  const time = which === 'a' ? ab.aTime : ab.bTime
  const hit = findBeatAt(segments, time)
  return hit
    ? `${label}: 小节${hit.segIndex}·拍${hit.beatInSeg} (${time.toFixed(2)}s)`
    : `${label}: —`
}

function formatSegmentRanges(ids: number[]): string {
  const sorted = [...new Set(ids)].sort((a, b) => a - b)
  const ranges: string[] = []
  for (let start = 0; start < sorted.length; ) {
    let end = start
    while (end + 1 < sorted.length && sorted[end + 1] === sorted[end] + 1) end += 1
    ranges.push(start === end ? `${sorted[start]}` : `${sorted[start]}–${sorted[end]}`)
    start = end + 1
  }
  return ranges.join('、')
}

export default function ControlBar({
  playing,
  canPrev,
  canNext,
  currentSegment,
  currentTime,
  duration,
  onSeekTime,
  onTogglePlay,
  onPrev,
  onNext,
  onMarkLearned,
  learned,
  segments,
  onSetA,
  onSetB,
  onClearAB,
  onCompare,
  comparing = false,
  onConfirmBeatOffset,
  onShowShortcuts,
}: Props) {
  const playbackRate = useLessonStore((s) => s.playbackRate)
  const setPlaybackRate = useLessonStore((s) => s.setPlaybackRate)
  const mirror = useLessonStore((s) => s.mirror)
  const setMirror = useLessonStore((s) => s.setMirror)
  const beatMirror = useLessonStore((s) => s.beatMirror)
  const setBeatMirror = useLessonStore((s) => s.setBeatMirror)
  const loopEnabled = useLessonStore((s) => s.loopEnabled)
  const loopMode = useLessonStore((s) => s.loopMode)
  const setLoopMode = useLessonStore((s) => s.setLoopMode)
  const toggleLoopEnabled = useLessonStore((s) => s.toggleLoopEnabled)
  const loopSegmentIds = useLessonStore((s) => s.loopSegmentIds)
  const abLoop = useLessonStore((s) => s.abLoop)
  const voiceEnabled = useLessonStore((s) => s.voiceEnabled)
  const setVoiceEnabled = useLessonStore((s) => s.setVoiceEnabled)
  const voiceVolume = useLessonStore((s) => s.voiceVolume)
  const setVoiceVolume = useLessonStore((s) => s.setVoiceVolume)
  const metronomeEnabled = useLessonStore((s) => s.metronomeEnabled)
  const setMetronomeEnabled = useLessonStore((s) => s.setMetronomeEnabled)
  const metronomeSound = useLessonStore((s) => s.metronomeSound)
  const setMetronomeSound = useLessonStore((s) => s.setMetronomeSound)
  const metronomeRate = useLessonStore((s) => s.metronomeRate)
  const setMetronomeRate = useLessonStore((s) => s.setMetronomeRate)
  const metronomeVolume = useLessonStore((s) => s.metronomeVolume)
  const setMetronomeVolume = useLessonStore((s) => s.setMetronomeVolume)
  const beatOffset = useLessonStore((s) => s.beatOffset)
  const draftBeatOffset = useLessonStore((s) => s.draftBeatOffset)
  const setBeatOffset = useLessonStore((s) => s.setBeatOffset)
  const setDraftBeatOffset = useLessonStore((s) => s.setDraftBeatOffset)
  const loopCount = useLessonStore((s) => s.loopCount)
  const setLoopCount = useLessonStore((s) => s.setLoopCount)

  const validAB = abLoop != null && abLoop.aTime < abLoop.bTime
  const canEnableLoop =
    loopMode === 'current' ||
    loopMode === 'front' ||
    loopMode === 'back' ||
    loopMode === 'single' ||
    (loopMode === 'multi' && loopSegmentIds.length > 0) ||
    (loopMode === 'ab' && validAB)
  const disabledReason =
    loopMode === 'multi'
      ? '请先勾选要循环的段落（在左侧小节列表）'
      : loopMode === 'ab'
        ? '请先设 A、B（A 须早于 B）'
        : ''
  const summary = !loopEnabled
    ? '循环已关闭'
    : loopMode === 'current'
      ? '循环中 · 当前（前一拍＋当前拍＋后一拍）'
      : loopMode === 'front'
        ? `循环中 · 前节（第 ${currentSegment} 节 1–4 拍）`
        : loopMode === 'back'
          ? `循环中 · 后节（第 ${currentSegment} 节 5–8 拍）`
          : loopMode === 'single'
            ? `循环中 · 单节（第 ${currentSegment} 节）`
            : loopMode === 'multi'
              ? `循环中 · 多节（第 ${formatSegmentRanges(loopSegmentIds)} 节）`
              : `循环中 · AB（${formatABPoint('', abLoop, 'a', segments).replace(': ', '')} → ${formatABPoint('', abLoop, 'b', segments).replace(': ', '')}）`

  return (
    <Stack spacing={2} sx={{ mt: 2 }} alignItems="center">
      <Stack direction="row" spacing={1} alignItems="center">
        <IconButton onClick={onPrev} disabled={!canPrev} aria-label="上一节">
          <SkipPreviousIcon />
        </IconButton>
        <IconButton
          onClick={onTogglePlay}
          color="primary"
          sx={{ border: 1 }}
          aria-label={playing ? '暂停' : '播放'}
        >
          {playing ? <PauseIcon /> : <PlayArrowIcon />}
        </IconButton>
        <IconButton onClick={onNext} disabled={!canNext} aria-label="下一节">
          <SkipNextIcon />
        </IconButton>
      </Stack>

      <Stack direction="row" spacing={1} alignItems="center" sx={{ width: '100%' }}>
        <Typography variant="caption" sx={{ minWidth: 42 }}>
          {formatDuration(currentTime)}
        </Typography>
        <Slider
          min={0}
          max={Math.max(duration, 0.01)}
          step={0.01}
          value={Math.min(currentTime, Math.max(duration, 0.01))}
          onChange={(_, value) => onSeekTime(value as number)}
          aria-label="视频播放进度"
        />
        <Typography variant="caption" sx={{ minWidth: 42, textAlign: 'right' }}>
          {formatDuration(duration)}
        </Typography>
      </Stack>

      <Stack direction="row" spacing={2} alignItems="center" justifyContent="center" flexWrap="wrap">
        <Stack direction="row" spacing={1} alignItems="center">
          <Typography variant="body2" color="text.secondary">速度</Typography>
          <Slider
            size="small"
            min={0.25}
            max={1.5}
            step={0.05}
            value={playbackRate}
            onChange={(_, value) => setPlaybackRate(value as number)}
            valueLabelDisplay="auto"
            valueLabelFormat={(value) => `${Number(value).toFixed(2)}x`}
            aria-label="播放速度"
            sx={{ width: 160 }}
          />
          <Typography variant="body2" sx={{ minWidth: 52, fontVariantNumeric: 'tabular-nums' }}>
            {playbackRate.toFixed(2)}x
          </Typography>
          <Button size="small" variant={playbackRate === 1 ? 'contained' : 'outlined'} onClick={() => setPlaybackRate(1)}>
            1x
          </Button>
        </Stack>

        <Tooltip title={!canEnableLoop && !loopEnabled ? disabledReason : `${summary}；点击切换`}>
          <span>
            <Button
              variant={loopEnabled ? 'contained' : 'outlined'}
              startIcon={<ReplayIcon />}
              onClick={toggleLoopEnabled}
              disabled={!canEnableLoop && !loopEnabled}
              aria-pressed={loopEnabled}
            >
              循环
            </Button>
          </span>
        </Tooltip>
        <ToggleButtonGroup
          exclusive
          size="small"
          value={loopMode}
          onChange={(_, value: LoopMode | null) => value && setLoopMode(value)}
          aria-label="循环模式"
        >
          <ToggleButton value="current">当前</ToggleButton>
          <ToggleButton value="front">前节</ToggleButton>
          <ToggleButton value="back">后节</ToggleButton>
          <ToggleButton value="single">单节</ToggleButton>
          <ToggleButton value="multi">多节</ToggleButton>
          <ToggleButton value="ab">AB</ToggleButton>
        </ToggleButtonGroup>

        <Tooltip title="仅翻转视频画面">
          <Button variant={mirror ? 'contained' : 'outlined'} startIcon={<FlipIcon />} onClick={() => setMirror(!mirror)}>
            视频镜像
          </Button>
        </Tooltip>
        <Tooltip title="独立翻转拍点提示，不影响视频画面">
          <Button variant={beatMirror ? 'contained' : 'outlined'} onClick={() => setBeatMirror(!beatMirror)}>
            拍点镜像
          </Button>
        </Tooltip>
        <Tooltip title="口令提示（语音数拍）">
          <Button
            variant={voiceEnabled ? 'contained' : 'outlined'}
            startIcon={<RecordVoiceOverIcon />}
            onClick={() => {
              const next = !voiceEnabled
              if (next) void unlockCountVoiceAudio()
              setVoiceEnabled(next)
            }}
          >
            口令
          </Button>
        </Tooltip>
        {voiceEnabled && (
          <Stack direction="row" spacing={1} alignItems="center">
            <Typography variant="body2" color="text.secondary">
              口令音量
            </Typography>
            <Slider
              size="small"
              min={0}
              max={2}
              step={0.05}
              value={voiceVolume}
              onChange={(_, value) => setVoiceVolume(value as number)}
              valueLabelDisplay="auto"
              valueLabelFormat={(value) => `${Math.round(Number(value) * 100)}%`}
              aria-label="口令音量"
              sx={{ width: 120 }}
            />
            <Typography
              variant="body2"
              sx={{ minWidth: 44, fontVariantNumeric: 'tabular-nums' }}
            >
              {Math.round(voiceVolume * 100)}%
            </Typography>
          </Stack>
        )}
        <Tooltip title="跟随当前拍网格发声；每小节第 1 拍为重音">
          <Button
            variant={metronomeEnabled ? 'contained' : 'outlined'}
            startIcon={<MusicNoteIcon />}
            onClick={() => {
              const next = !metronomeEnabled
              if (next) void unlockMetronomeAudio()
              setMetronomeEnabled(next)
            }}
          >
            节拍器
          </Button>
        </Tooltip>
        {metronomeEnabled && (
          <Stack direction="row" spacing={1} alignItems="center" flexWrap="wrap">
            <Typography variant="body2" color="text.secondary">
              节拍速度
            </Typography>
            <ToggleButtonGroup
              exclusive
              size="small"
              value={metronomeRate}
              onChange={(_, value: MetronomeRate | null) =>
                value && setMetronomeRate(value)
              }
              aria-label="节拍器速度"
            >
              <ToggleButton value="half">慢拍 ½×</ToggleButton>
              <ToggleButton value="normal">正常 1×</ToggleButton>
              <ToggleButton value="double">快拍 2×</ToggleButton>
            </ToggleButtonGroup>
            <ToggleButtonGroup
              exclusive
              size="small"
              value={metronomeSound}
              onChange={(_, value: MetronomeSound | null) =>
                value && setMetronomeSound(value)
              }
              aria-label="节拍器声音"
            >
              <ToggleButton value="click">清脆</ToggleButton>
              <ToggleButton value="wood">木鱼</ToggleButton>
              <ToggleButton value="beep">电子</ToggleButton>
            </ToggleButtonGroup>
            <Typography variant="body2" color="text.secondary">
              节拍器音量
            </Typography>
            <Slider
              size="small"
              min={0}
              max={2}
              step={0.05}
              value={metronomeVolume}
              onChange={(_, value) => setMetronomeVolume(value as number)}
              valueLabelDisplay="auto"
              valueLabelFormat={(value) => `${Math.round(Number(value) * 100)}%`}
              aria-label="节拍器音量"
              sx={{ width: 120 }}
            />
            <Typography
              variant="body2"
              sx={{ minWidth: 44, fontVariantNumeric: 'tabular-nums' }}
            >
              {Math.round(metronomeVolume * 100)}%
            </Typography>
          </Stack>
        )}
        <Tooltip title={comparing ? '退出对照分屏' : '左右分屏对比（左老师 / 右自己）'}>
          <Button
            variant={comparing ? 'outlined' : 'contained'}
            color="secondary"
            startIcon={comparing ? <VideocamOffIcon /> : <VideocamIcon />}
            onClick={onCompare}
          >
            {comparing ? '退出对照' : '对照练习'}
          </Button>
        </Tooltip>
        <Tooltip title="查看扒舞快捷键">
          <Button
            variant="outlined"
            startIcon={<KeyboardIcon />}
            onClick={onShowShortcuts}
          >
            快捷键 ?
          </Button>
        </Tooltip>
      </Stack>

      <Typography variant="caption" color={loopEnabled ? 'primary' : 'text.secondary'}>
        {summary}
        {!loopEnabled && loopMode === 'multi' && ` · 已选 ${loopSegmentIds.length} 节（在左侧列表勾选）`}
      </Typography>

      {loopMode === 'ab' && (
        <Stack direction="row" spacing={1} alignItems="center" flexWrap="wrap">
          <Typography variant="body2" color="text.secondary">AB 循环</Typography>
          <Button size="small" variant="outlined" onClick={onSetA}>设 A</Button>
          <Button size="small" variant="outlined" onClick={onSetB}>设 B</Button>
          <Typography variant="caption">{formatABPoint('A', abLoop, 'a', segments)}</Typography>
          <Typography variant="caption">{formatABPoint('B', abLoop, 'b', segments)}</Typography>
          {abLoop && (
            <Button size="small" variant="text" color="error" onClick={onClearAB}>
              清除
            </Button>
          )}
        </Stack>
      )}

      <Stack direction="row" spacing={1} alignItems="center" flexWrap="wrap">
        <FormControlLabel
          control={<Switch checked={loopCount != null} onChange={(event) => setLoopCount(event.target.checked ? 5 : null)} />}
          label="限制循环次数"
        />
        {loopCount != null && (
          <>
            <Slider
              size="small"
              min={3}
              max={10}
              step={1}
              value={loopCount}
              onChange={(_, value) => setLoopCount(value as number)}
              valueLabelDisplay="auto"
              aria-label="循环次数"
              sx={{ width: 160 }}
            />
            <Typography variant="body2">{loopCount} 次 · 到数后继续播</Typography>
          </>
        )}
      </Stack>

      <Box sx={{ width: '100%', maxWidth: 520 }}>
        <Stack direction="row" spacing={1} alignItems="center">
          <Typography variant="body2" color="text.secondary" sx={{ whiteSpace: 'nowrap' }}>
            拍点偏移
          </Typography>
          <Slider
            size="small"
            min={-4}
            max={4}
            step={1}
            value={draftBeatOffset}
            onChange={(_, value) => setDraftBeatOffset(value as number)}
            valueLabelDisplay="auto"
            valueLabelFormat={(value) => `${Number(value) > 0 ? '+' : ''}${value} 拍`}
            aria-label="拍点偏移草稿（拍）"
          />
          <Typography variant="body2" sx={{ minWidth: 44 }}>
            {draftBeatOffset > 0 ? '+' : ''}{draftBeatOffset} 拍
          </Typography>
          <Button
            size="small"
            variant="contained"
            disabled={draftBeatOffset === beatOffset}
            onClick={() =>
              onConfirmBeatOffset
                ? onConfirmBeatOffset(draftBeatOffset)
                : setBeatOffset(draftBeatOffset)
            }
          >
            重新计算拍子
          </Button>
        </Stack>
      </Box>

      <Button
        variant={learned ? 'outlined' : 'contained'}
        color={learned ? 'success' : 'primary'}
        onClick={onMarkLearned}
      >
        {learned ? '取消「已学会」' : '标记已学会 ✓'}
      </Button>
      <Button variant="text" endIcon={<SkipNextIcon />} onClick={onNext} disabled={!canNext}>
        下一节 →
      </Button>
    </Stack>
  )
}
