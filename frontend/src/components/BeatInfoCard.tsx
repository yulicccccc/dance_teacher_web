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

  const parsed = parseFloat(input)
  const isValid = !Number.isNaN(parsed) && parsed >= BPM_MIN && parsed <= BPM_MAX
  const level = confidenceLevel(confidence)
  const disabled = !isValid || loading

  const handleApply = () => {
    if (disabled) return
    onApplyBpm(parsed)
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
        </Box>
      </CardContent>
    </Card>
  )
}
