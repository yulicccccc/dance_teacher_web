import { Box, Stack } from '@mui/material'

interface Props {
  beatIndex: number // 1..8 (0 = none yet)
  pulse: boolean
  total?: number
}

/**
 * Visual beat counter overlaid on the video (PRD P0-7). Shows the current
 * 1..8 count big in the center plus a row of dots with the active beat
 * highlighted and scaling on each pulse — the "dance-studio counting" feel.
 */
export default function BeatOverlay({ beatIndex, pulse, total = 8 }: Props) {
  return (
    <Box
      className="absolute top-0 left-0 p-4 pointer-events-none flex flex-col items-start"
      sx={{ textShadow: '0 2px 12px rgba(0,0,0,0.6)' }}
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
          return (
            <Box
              key={i}
              className="rounded-full"
              style={{
                width: 14,
                height: 14,
                background: on ? '#22d3ee' : 'rgba(255,255,255,0.3)',
                transform: on && pulse ? 'scale(1.4)' : 'scale(1)',
                transition: 'transform 200ms ease-out',
              }}
            />
          )
        })}
      </Stack>
    </Box>
  )
}
