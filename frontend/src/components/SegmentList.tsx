import {
  Box,
  Button,
  Checkbox,
  Chip,
  List,
  ListItemButton,
  ListItemText,
  Stack,
} from '@mui/material'
import CheckCircleIcon from '@mui/icons-material/CheckCircle'
import type { Segment } from '../types/api'
import { formatDuration } from '../utils/format'
import { computePaddedLoopBounds } from '../hooks/useBeatSync'

interface Props {
  segments: Segment[]
  currentSegment: number
  learnedSegments: number[]
  onSelect: (index: number) => void
  /** Multi-loop selection belongs in the left rail, not a duplicate panel. */
  multiSelect?: boolean
  selectedLoopIds?: number[]
  onToggleLoopId?: (index: number) => void
  onSelectAll?: () => void
  onClearSelection?: () => void
  /** In single mode, show the exact padded playback window for every segment. */
  showLoopBounds?: boolean
  beatDuration?: number
}

/** Left-rail phrase navigator and, in multi mode, the sole loop selector. */
export default function SegmentList({
  segments,
  currentSegment,
  learnedSegments,
  onSelect,
  multiSelect = false,
  selectedLoopIds = [],
  onToggleLoopId,
  onSelectAll,
  onClearSelection,
  showLoopBounds = false,
  beatDuration = 0,
}: Props) {
  return (
    <Box>
      {multiSelect && (
        <Stack direction="row" spacing={1} sx={{ mb: 1 }}>
          <Button size="small" onClick={onSelectAll} disabled={segments.length === 0}>
            全选
          </Button>
          <Button
            size="small"
            onClick={onClearSelection}
            disabled={selectedLoopIds.length === 0}
          >
            清空
          </Button>
        </Stack>
      )}
      <List sx={{ width: '100%', maxHeight: '72vh', overflow: 'auto' }}>
        {segments.map((seg) => {
          const isCurrent = seg.index === currentSegment
          const learned = learnedSegments.includes(seg.index)
          const selectedForLoop = selectedLoopIds.includes(seg.index)
          const loopBounds = showLoopBounds
            ? computePaddedLoopBounds(seg, segments, beatDuration)
            : null
          const firstBeat = seg.startBeat ?? 1
          const lastBeat = firstBeat + seg.beats.length - 1
          const partial = seg.beats.length > 0 && (firstBeat !== 1 || seg.beats.length < 8)
          const partialLabel = partial
            ? `残缺小节 · ${firstBeat === lastBeat ? `${firstBeat} 拍` : `${firstBeat}–${lastBeat} 拍`}\n`
            : ''
          const secondary = loopBounds
            ? `${partialLabel}时长 ${formatDuration(seg.endTime - seg.startTime)}\n循环 ${loopBounds.loopStart.toFixed(2)}–${loopBounds.loopEnd.toFixed(2)} 秒`
            : `${partialLabel}时长 ${formatDuration(seg.endTime - seg.startTime)}`
          return (
            <ListItemButton
              key={seg.index}
              selected={isCurrent}
              onClick={() => onSelect(seg.index)}
              sx={{
                borderRadius: 2,
                mb: 0.5,
                border: isCurrent ? 2 : 1,
                borderColor: isCurrent ? 'primary.main' : 'divider',
                bgcolor:
                  multiSelect && selectedForLoop ? 'action.selected' : undefined,
              }}
            >
              {multiSelect && (
                <Checkbox
                  checked={selectedForLoop}
                  onClick={(event) => event.stopPropagation()}
                  onChange={() => onToggleLoopId?.(seg.index)}
                  inputProps={{ 'aria-label': `选择第 ${seg.index} 小节循环` }}
                  sx={{ pl: 0 }}
                />
              )}
              <ListItemText
                primary={`${seg.index} / ${segments.length} 小节`}
                secondary={secondary}
                secondaryTypographyProps={{ sx: { whiteSpace: 'pre-line' } }}
              />
              {learned && (
                <Chip
                  icon={<CheckCircleIcon />}
                  label="已学会"
                  color="success"
                  size="small"
                  sx={{ ml: 1 }}
                />
              )}
            </ListItemButton>
          )
        })}
      </List>
    </Box>
  )
}
