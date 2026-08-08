import { Box, CircularProgress, Typography } from '@mui/material'

export default function EngineLoadingHint({ label }: { label: string }) {
  return (
    <Box sx={{ display: 'flex', alignItems: 'center', gap: 2, justifyContent: 'center', my: 3 }}>
      <CircularProgress size={28} />
      <Typography variant="body1" color="text.secondary">
        {label}
      </Typography>
    </Box>
  )
}
