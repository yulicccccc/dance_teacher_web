import { Box, Button, Checkbox, FormControlLabel, Radio, RadioGroup, Stack, Typography } from '@mui/material'
import { useLessonStore } from '../store/lessonStore'
import { formatDuration } from '../utils/format'
import type { Segment } from '../types/api'

interface Props {
  /** The (offset-baked) segments to offer as loop candidates. */
  segments: Segment[]
}

/**
 * Loop configuration panel (Part 2). Offers two loop flavours:
 *
 *  - `single`  → loop the segment the playhead is currently in (classic
 *    behaviour, padded by one beat each side; see `useBeatSync`).
 *  - `multi`   → tick one or more segments; `useBeatSync` then cycles through
 *    the selected set (each padded), wrapping the last back to the first. An
 *    empty selection degrades to `single` inside the engine.
 *
 * All state lives in `useLessonStore` (`loopMode`, `loopSegmentIds`); this
 * component is a thin, controlled view over it.
 */
export default function LoopPanel({ segments }: Props) {
  const loopMode = useLessonStore((s) => s.loopMode)
  const setLoopMode = useLessonStore((s) => s.setLoopMode)
  const loopSegmentIds = useLessonStore((s) => s.loopSegmentIds)
  const toggleLoopSegmentId = useLessonStore((s) => s.toggleLoopSegmentId)
  const setLoopSegmentIds = useLessonStore((s) => s.setLoopSegmentIds)

  return (
    <Box sx={{ width: '100%', maxWidth: 420 }}>
      <Stack direction="row" spacing={2} alignItems="center" flexWrap="wrap">
        <Typography variant="body2" color="text.secondary">
          循环方式
        </Typography>
        <RadioGroup
          row
          value={loopMode}
          onChange={(e) => setLoopMode(e.target.value as 'single' | 'multi')}
        >
          <FormControlLabel value="single" control={<Radio size="small" />} label="单节" />
          <FormControlLabel value="multi" control={<Radio size="small" />} label="多选段落" />
        </RadioGroup>
      </Stack>

      {loopMode === 'multi' && (
        <Box sx={{ mt: 1 }}>
          <Stack direction="row" spacing={1} sx={{ mb: 0.5 }}>
            <Button
              size="small"
              variant="text"
              onClick={() => setLoopSegmentIds(segments.map((s) => s.index))}
            >
              全选
            </Button>
            <Button size="small" variant="text" onClick={() => setLoopSegmentIds([])}>
              清空
            </Button>
          </Stack>
          <Stack spacing={0.25}>
            {segments.map((s) => (
              <FormControlLabel
                key={s.index}
                control={
                  <Checkbox
                    size="small"
                    checked={loopSegmentIds.includes(s.index)}
                    onChange={() => toggleLoopSegmentId(s.index)}
                  />
                }
                label={`第 ${s.index} 节 (${formatDuration(s.startTime)} – ${formatDuration(
                  s.endTime,
                )})`}
              />
            ))}
          </Stack>
        </Box>
      )}
    </Box>
  )
}
