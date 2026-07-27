import { Chip, List, ListItemButton, ListItemText } from '@mui/material'
import CheckCircleIcon from '@mui/icons-material/CheckCircle'
import type { Segment } from '../types/api'
import { formatDuration } from '../utils/format'

interface Props {
  segments: Segment[]
  currentSegment: number
  learnedSegments: number[]
  onSelect: (index: number) => void
}

/** Left-rail phrase navigator: lists every 8-beat section with status. */
export default function SegmentList({
  segments,
  currentSegment,
  learnedSegments,
  onSelect,
}: Props) {
  return (
    <List sx={{ width: '100%', maxHeight: '72vh', overflow: 'auto' }}>
      {segments.map((seg) => {
        const isCurrent = seg.index === currentSegment
        const learned = learnedSegments.includes(seg.index)
        return (
          <ListItemButton
            key={seg.index}
            selected={isCurrent}
            onClick={() => onSelect(seg.index)}
            sx={{ borderRadius: 2, mb: 0.5 }}
          >
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
  )
}
