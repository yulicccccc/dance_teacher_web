import { Box, Stack } from '@mui/material'

interface Props {
  beatIndex: number // 1..8 (0 = none yet)
  pulse: boolean
  total?: number
  /** Mirror the overlay horizontally (dance-studio mirror view). */
  mirror?: boolean
  /** Click a beat dot to jump; receives the 0-based dot index. */
  onDotClick?: (segmentIndex: number) => void
}

/**
 * Visual beat counter overlaid on the video (PRD P0-7). Shows the current
 * 1..8 count big in the center plus a row of dots with the active beat
 * highlighted and scaling on each pulse — the "dance-studio counting" feel.
 */
export default function BeatOverlay({
  beatIndex,
  pulse,
  total = 8,
  mirror = false,
  onDotClick,
}: Props) {
  return (
    <Box
      className="absolute top-0 left-0 p-4 pointer-events-none flex flex-col items-start"
      // Mirror the whole overlay so the count/dots line up with the mirrored
      // video. The digits flip too — that is the intended mirror view. Applied
      // via an inline `style` (not `sx`) so it is a plain `scaleX(-1)` that the
      // runtime and tests can read directly off the element.
      style={{
        textShadow: '0 2px 12px rgba(0,0,0,0.6)',
        transform: mirror ? 'scaleX(-1)' : 'none',
      }}
    >
      <Box
        className="font-bold select-none"
        style={{
          fontSize: '6rem',
          color: '#fff',
          transform: pulse ? 'scale(1.25)' : 'scale(1)',
          transition: 'transform 200ms ease-out',
        }}
      >
        {beatIndex > 0 ? beatIndex : ''}
      </Box>
      <Stack direction="row" spacing={1} className="mt-4">
        {Array.from({ length: total }).map((_, i) => {
          const on = i + 1 === beatIndex
          const clickable = typeof onDotClick === 'function'
          return (
            <Box
              key={i}
              className="rounded-full"
              onClick={
                clickable
                  ? (event) => {
                      event.stopPropagation()
                      onDotClick(i)
                    }
                  : undefined
              }
              onDoubleClick={
                clickable
                  ? (event) => {
                      event.preventDefault()
                      event.stopPropagation()
                    }
                  : undefined
              }
              sx={{
                width: 14,
                height: 14,
                background: on ? '#22d3ee' : 'rgba(255,255,255,0.3)',
                transform: on && pulse ? 'scale(1.4)' : 'scale(1)',
                transition: 'transform 200ms ease-out',
                // Dots are clickable even though the overlay is pointer-events
                // none; re-enable events only on the dots themselves.
                pointerEvents: clickable ? 'auto' : 'none',
                cursor: clickable ? 'pointer' : 'default',
              }}
            />
          )
        })}
      </Stack>
    </Box>
  )
}
