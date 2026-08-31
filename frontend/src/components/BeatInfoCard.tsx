import { useState } from 'react'
import {
  Box,
  Button,
  Card,
  CardContent,
  CircularProgress,
  TextField,
  Tooltip,
  Typography,
} from '@mui/material'

export interface BeatInfoCardProps {
  /** Detected BPM reported by the backend (drives the initial field value). */
  bpm: number
  /** Detection confidence in [0, 1] — shown as a coloured dot + label. */
  confidence: number
  /** When true the recompute button is disabled and shows a spinner. */
  loading?: boolean
  /** Called with the user-confirmed BPM when "用此 BPM 重算" is clicked. */
  onApplyBpm: (bpm: number) => void
}

const BPM_MIN = 40
const BPM_MAX = 300

/** Robust tempo estimate: the median keeps one early/late tap from dominating. */
export function estimateTappedBpm(tapTimes: number[]): number | null {
  if (tapTimes.length < 2) return null
  const intervals = tapTimes
    .slice(1)
    .map((time, index) => time - tapTimes[index])
    .filter((interval) => interval >= 200 && interval <= 1500)
    .sort((a, b) => a - b)
  if (intervals.length === 0) return null
  const middle = Math.floor(intervals.length / 2)
  const median =
    intervals.length % 2 === 0
      ? (intervals[middle - 1] + intervals[middle]) / 2
      : intervals[middle]
  const tappedBpm = 60_000 / median
  if (tappedBpm < BPM_MIN || tappedBpm > BPM_MAX) return null
  return Math.round(tappedBpm * 10) / 10
}

/** Map a confidence value to a human label and a dot colour. */
function confidenceLevel(confidence: number): { label: string; color: string } {
  if (confidence >= 0.8) return { label: '高', color: '#4caf50' }
  if (confidence >= 0.5) return { label: '中', color: '#ed6c02' }
  return { label: '低', color: '#f44336' }
}

/**
 * Persistent "节拍信息" card: shows the detected BPM and confidence, and lets the
 * user override the tempo by typing a corrected BPM and re-deriving the 8-beat
 * segments at that exact tempo (the `fixedBpm` recompute mode).
 */
export default function BeatInfoCard({
  bpm,
  confidence,
  loading = false,
  onApplyBpm,
}: BeatInfoCardProps) {
  // Start the editable field at the detected value (1 decimal place).
  const [input, setInput] = useState<string>(bpm.toFixed(1))
  const [tapTimes, setTapTimes] = useState<number[]>([])
  const [tapBpm, setTapBpm] = useState<number | null>(null)

  const parsed = parseFloat(input)
  const isValid = !Number.isNaN(parsed) && parsed >= BPM_MIN && parsed <= BPM_MAX
  const level = confidenceLevel(confidence)
  const disabled = !isValid || loading

  const handleApply = () => {
    if (disabled) return
    onApplyBpm(parsed)
  }

  const handleTap = () => {
    const now = performance.now()
    const last = tapTimes[tapTimes.length - 1]
    const recent =
      tapTimes.length > 0 && now - last <= 2000
        ? [...tapTimes, now].slice(-9)
        : [now]
    const estimate = estimateTappedBpm(recent)
    setTapTimes(recent)
    setTapBpm(estimate)
    if (recent.length >= 4 && estimate != null) setInput(estimate.toFixed(1))
  }

  const clearTaps = () => {
    setTapTimes([])
    setTapBpm(null)
  }

  return (
    <Card variant="outlined" sx={{ mb: 2 }}>
      <CardContent>
        <Typography variant="subtitle1" sx={{ fontWeight: 600, mb: 1 }}>
          节拍信息
        </Typography>

        <Box sx={{ display: 'flex', alignItems: 'center', gap: 3, flexWrap: 'wrap' }}>
          <Typography variant="body2" color="text.secondary">
            检测 BPM：<strong>{bpm.toFixed(1)}</strong>
          </Typography>

          <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
            <Tooltip title={`置信度 ${(confidence * 100).toFixed(0)}%`}>
              <Box
                component="span"
                sx={{
                  width: 12,
                  height: 12,
                  borderRadius: '50%',
                  bgcolor: level.color,
                  display: 'inline-block',
                }}
              />
            </Tooltip>
            <Typography variant="body2" color="text.secondary">
              置信度：{level.label}
            </Typography>
          </Box>
        </Box>

        <Box sx={{ display: 'flex', alignItems: 'center', gap: 2, mt: 2, flexWrap: 'wrap' }}>
          <TextField
            label="BPM"
            type="number"
            size="small"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            inputProps={{ min: BPM_MIN, max: BPM_MAX, step: 0.1 }}
            error={!isValid}
            helperText={!isValid ? `BPM 需在 ${BPM_MIN}–${BPM_MAX} 之间` : ' '}
            sx={{ width: 140 }}
          />
          <Button
            variant="contained"
            disabled={disabled}
            onClick={handleApply}
            startIcon={
              loading ? <CircularProgress size={16} color="inherit" /> : undefined
            }
          >
            用此 BPM 重算
          </Button>
          <Button variant="outlined" onClick={handleTap}>
            跟拍点按 BPM{tapTimes.length > 0 ? `（${Math.min(tapTimes.length, 4)}/4）` : ''}
          </Button>
          {tapTimes.length > 0 && (
            <Button variant="text" onClick={clearTaps}>
              清除点按
            </Button>
          )}
        </Box>
        <Typography variant="caption" color="text.secondary">
          {tapBpm != null
            ? `点按估算：${tapBpm.toFixed(1)} BPM${tapTimes.length >= 4 ? '，已填入上方' : '，继续点到 4 下更稳'}`
            : '听着音乐每拍点一下；停顿超过 2 秒会自动重新开始。'}
        </Typography>
        <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mt: 0.5 }}>
          判断技巧：节拍器越播越偏通常是 BPM 不对；始终固定错同样的拍数，通常是第一拍，需要调“拍点偏移”。
        </Typography>
      </CardContent>
    </Card>
  )
}
