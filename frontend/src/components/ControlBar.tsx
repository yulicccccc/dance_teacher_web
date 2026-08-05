import {
  Box,
  Button,
  FormControlLabel,
  IconButton,
  Slider,
  Stack,
  Switch,
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
import { useLessonStore } from '../store/lessonStore'
import { findBeatAt } from '../utils/segmentMath'
import LoopPanel from './LoopPanel'
import type { Segment, ABLoop } from '../types/api'

interface Props {
  playing: boolean
  canPrev: boolean
  canNext: boolean
  onTogglePlay: () => void
  onPrev: () => void
  onNext: () => void
  onMarkLearned: () => void
  learned: boolean
  /** Offset beat grid (already bakes in `beatOffset`), used to label A/B points. */
  segments: Segment[]
  /** Current custom A→B loop state (null when not configured). */
  abLoop: ABLoop | null
  onSetA: () => void
  onSetB: () => void
  onEnableAB: () => void
  onDisableAB: () => void
  onClearAB: () => void
  /** Toggle the in-place split-screen comparison (teacher left / learner right). */
  onCompare: () => void
  /** True while the split-screen comparison is showing, so the button reads as a toggle. */
  comparing?: boolean
}

/**
 * Format an A/B point as "小节X·拍Y (t.sss)" using the offset beat grid so the
 * user can see exactly which beat each loop endpoint snapped to.
 */
function formatABPoint(
  label: string,
  ab: ABLoop | null,
  which: 'a' | 'b',
  segments: Segment[],
): string {
  if (!ab) return `${label}: —`
  const t = which === 'a' ? ab.aTime : ab.bTime
  const hit = findBeatAt(segments, t)
  if (!hit) return `${label}: —`
  return `${label}: 小节${hit.segIndex}·拍${hit.beatInSeg} (${t.toFixed(2)}s)`
}

/**
 * Bottom control bar — the "teacher actions" as one-click toggles: variable
 * playback speed (continuous slider), single-segment loop, custom A→B loop
 * (beat-anchored), mirror flip, voice count, plus phrase navigation and the
 * "next section" affordance (PRD P0-5/6/8).
 */
export default function ControlBar({
  playing,
  canPrev,
  canNext,
  onTogglePlay,
  onPrev,
  onNext,
  onMarkLearned,
  learned,
  segments,
  abLoop,
  onSetA,
  onSetB,
  onEnableAB,
  onDisableAB,
  onClearAB,
  onCompare,
  comparing = false,
}: Props) {
  const playbackRate = useLessonStore((s) => s.playbackRate)
  const setPlaybackRate = useLessonStore((s) => s.setPlaybackRate)
  const mirror = useLessonStore((s) => s.mirror)
  const setMirror = useLessonStore((s) => s.setMirror)
  const loopSegment = useLessonStore((s) => s.loopSegment)
  const setLoopSegment = useLessonStore((s) => s.setLoopSegment)
  const voiceEnabled = useLessonStore((s) => s.voiceEnabled)
  const setVoiceEnabled = useLessonStore((s) => s.setVoiceEnabled)
  const beatOffset = useLessonStore((s) => s.beatOffset)
  const setBeatOffset = useLessonStore((s) => s.setBeatOffset)
  const loopCount = useLessonStore((s) => s.loopCount)
  const setLoopCount = useLessonStore((s) => s.setLoopCount)

  // A loop with aTime >= bTime is degenerate (A not before B) -> cannot enable.
  const abIncomplete = abLoop != null && abLoop.aTime >= abLoop.bTime

  return (
    <Stack spacing={2} sx={{ mt: 2 }} alignItems="center">
      <Stack direction="row" spacing={1} alignItems="center" justifyContent="center">
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

      <Stack
        direction="row"
        spacing={2}
        alignItems="center"
        justifyContent="center"
        flexWrap="wrap"
      >
        {/* 连续变速滑条：0.25x（抠动作）~ 1.5x，复用 playbackRate / setPlaybackRate */}
        <Stack direction="row" spacing={1} alignItems="center">
          <Typography variant="body2" color="text.secondary">
            速度
          </Typography>
          <Slider
            size="small"
            min={0.25}
            max={1.5}
            step={0.05}
            value={playbackRate}
            onChange={(_, v) => setPlaybackRate(v as number)}
            valueLabelDisplay="auto"
            valueLabelFormat={(v) => `${(v as number).toFixed(2)}x`}
            aria-label="播放速度"
            sx={{ width: 160 }}
          />
          <Typography
            variant="body2"
            sx={{
              whiteSpace: 'nowrap',
              minWidth: 52,
              textAlign: 'right',
              fontVariantNumeric: 'tabular-nums',
            }}
          >
            {`${playbackRate.toFixed(2)}x`}
          </Typography>
          <Button
            size="small"
            variant={playbackRate === 1 ? 'contained' : 'outlined'}
            onClick={() => setPlaybackRate(1)}
            sx={{ minWidth: 40 }}
          >
            1x
          </Button>
        </Stack>

        <Tooltip title="单节循环（含前后各一拍过渡，衔接更顺）">
          <Button
            variant={loopSegment ? 'contained' : 'outlined'}
            startIcon={<ReplayIcon />}
            onClick={() => setLoopSegment(!loopSegment)}
          >
            单节循环
          </Button>
        </Tooltip>
        {/* 多选段落循环配置：single/multi 切换 + 段落勾选清单（空选退化为单节）。
            始终挂载；loopMode 仅决定 useBeatSync 的循环方式，真正循环与否仍由
            上方「单节循环」主开关（loopSegment）控制。 */}
        <LoopPanel segments={segments} />
        <Tooltip title="镜像翻转（默认开，模拟镜面）">
          <Button
            variant={mirror ? 'contained' : 'outlined'}
            startIcon={<FlipIcon />}
            onClick={() => setMirror(!mirror)}
          >
            镜像
          </Button>
        </Tooltip>
        <Tooltip title="口令提示（语音数拍）">
          <Button
            variant={voiceEnabled ? 'contained' : 'outlined'}
            startIcon={<RecordVoiceOverIcon />}
            onClick={() => setVoiceEnabled(!voiceEnabled)}
          >
            口令
          </Button>
        </Tooltip>
        <Tooltip
          title={
            comparing
              ? '退出对照分屏，恢复普通播放'
              : '原地左右分屏对比（左老师 / 右自己，可录制下载；再次点击退出）'
          }
        >
          <Button
            variant={comparing ? 'outlined' : 'contained'}
            color="secondary"
            startIcon={comparing ? <VideocamOffIcon /> : <VideocamIcon />}
            onClick={onCompare}
          >
            {comparing ? '退出对照' : '对照练习'}
          </Button>
        </Tooltip>
      </Stack>

      {/* 循环次数限制：默认关闭 = 无限循环；开启后滑条 3–10 次。
          对单节循环与 AB 循环都生效；到数后退出并继续播放。 */}
      <Stack direction="row" spacing={1} alignItems="center" flexWrap="wrap">
        <FormControlLabel
          control={
            <Switch
              checked={loopCount != null}
              onChange={(e) => setLoopCount(e.target.checked ? 5 : null)}
            />
          }
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
              onChange={(_, v) => setLoopCount(v as number)}
              valueLabelDisplay="auto"
              valueLabelFormat={(v) => `${v} 次`}
              aria-label="循环次数"
              sx={{ width: 160 }}
            />
            <Typography
              variant="body2"
              sx={{
                whiteSpace: 'nowrap',
                minWidth: 44,
                textAlign: 'right',
                fontVariantNumeric: 'tabular-nums',
              }}
            >
              {`${loopCount} 次`}
            </Typography>
            <Tooltip title="对单节循环和 AB 循环都生效；到数后退出并继续播放">
              <Typography variant="caption" color="text.secondary">
                到数后继续播
              </Typography>
            </Tooltip>
          </>
        )}
      </Stack>

      {/* 自定义 A→B 循环（以拍子为单位，与单节循环互斥） */}
      <Stack direction="row" spacing={1} alignItems="center" flexWrap="wrap">
        <Typography variant="body2" color="text.secondary">
          AB 循环
        </Typography>
        <Tooltip title="以当前播放位置最近的拍点设为 A">
          <Button size="small" variant="outlined" onClick={onSetA}>
            设 A
          </Button>
        </Tooltip>
        <Tooltip title="以当前播放位置最近的拍点设为 B">
          <Button size="small" variant="outlined" onClick={onSetB}>
            设 B
          </Button>
        </Tooltip>
        <Typography
          variant="caption"
          sx={{ fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap' }}
        >
          {formatABPoint('A', abLoop, 'a', segments)}
        </Typography>
        <Typography
          variant="caption"
          sx={{ fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap' }}
        >
          {formatABPoint('B', abLoop, 'b', segments)}
        </Typography>
        {abLoop && !abLoop.enabled && (
          <Tooltip title={abIncomplete ? '请先设 A、B（A 须早于 B）' : '启用自定义循环'}>
            {/* span wrapper so the tooltip still shows on a disabled button */}
            <span>
              <Button
                size="small"
                variant="contained"
                color="primary"
                disabled={abIncomplete}
                onClick={onEnableAB}
              >
                启用
              </Button>
            </span>
          </Tooltip>
        )}
        {abLoop && abLoop.enabled && (
          <Button size="small" variant="outlined" color="warning" onClick={onDisableAB}>
            停用
          </Button>
        )}
        {abLoop && (
          <Button size="small" variant="text" color="error" onClick={onClearAB}>
            清除
          </Button>
        )}
      </Stack>

      <Box sx={{ width: '100%', maxWidth: 420 }}>
        <Stack direction="row" spacing={1.5} alignItems="center">
          <Typography variant="body2" color="text.secondary" sx={{ whiteSpace: 'nowrap' }}>
            拍点计数偏移
          </Typography>
          <Button
            size="small"
            variant="outlined"
            onClick={() => setBeatOffset(beatOffset - 1)}
            disabled={beatOffset <= -4}
            aria-label="计数减一拍"
          >
            −1 拍
          </Button>
          <Slider
            size="small"
            min={-4}
            max={4}
            step={1}
            value={beatOffset}
            onChange={(_, v) => setBeatOffset(v as number)}
            valueLabelDisplay="auto"
            valueLabelFormat={(v) => `${v > 0 ? '+' : ''}${v} 拍`}
            aria-label="拍点计数偏移（拍）"
          />
          <Button
            size="small"
            variant="outlined"
            onClick={() => setBeatOffset(beatOffset + 1)}
            disabled={beatOffset >= 4}
            aria-label="计数加一拍"
          >
            +1 拍
          </Button>
          <Typography
            variant="body2"
            sx={{ whiteSpace: 'nowrap', minWidth: 44, textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}
          >
            {`${beatOffset > 0 ? '+' : ''}${beatOffset} 拍`}
          </Typography>
        </Stack>
      </Box>

      <Button
        variant={learned ? 'outlined' : 'contained'}
        color={learned ? 'success' : 'primary'}
        onClick={onMarkLearned}
        sx={{ alignSelf: 'center' }}
      >
        {learned ? '取消「已学会」' : '标记已学会 ✓'}
      </Button>
      <Button
        variant="text"
        endIcon={<SkipNextIcon />}
        onClick={onNext}
        disabled={!canNext}
        sx={{ alignSelf: 'center' }}
      >
        下一节 →
      </Button>
    </Stack>
  )
}
