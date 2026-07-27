import { Box, IconButton, Toolbar, Typography } from '@mui/material'
import ArrowBackIcon from '@mui/icons-material/ArrowBack'

interface Props {
  videoName: string
  current: number
  total: number
  onBack: () => void
}

/** Top header for the lesson page: course name + x/N progress + back button. */
export default function ProgressHeader({ videoName, current, total, onBack }: Props) {
  return (
    <Box sx={{ borderBottom: 1, borderColor: 'divider', mb: 2 }}>
      <Toolbar>
        <IconButton edge="start" onClick={onBack} aria-label="返回">
          <ArrowBackIcon />
        </IconButton>
        <Box sx={{ flexGrow: 1, ml: 1 }}>
          <Typography variant="subtitle1" fontWeight={700} noWrap>
            课程：{videoName}
          </Typography>
          <Typography variant="body2" color="text.secondary">
            进度 {current}/{total} 小节
          </Typography>
        </Box>
      </Toolbar>
    </Box>
  )
}
