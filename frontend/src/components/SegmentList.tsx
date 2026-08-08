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
                secondary={`时长 ${formatDuration(seg.endTime - seg.startTime)}`}
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
