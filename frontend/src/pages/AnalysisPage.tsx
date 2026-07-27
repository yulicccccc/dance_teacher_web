import { useEffect } from 'react'
import { useLocation, useNavigate, useParams } from 'react-router-dom'
import {
  Box,
  Button,
  CircularProgress,
  Container,
  LinearProgress,
  Stack,
  Typography,
} from '@mui/material'
import { useAnalysisPolling } from '../hooks/useAnalysisPolling'
import type { TaskStatusValue } from '../types/api'

const STEP_ORDER: TaskStatusValue[] = [
  'queued',
  'extracting',
  'beat_detecting',
  'segmenting',
  'done',
]
const STEP_LABELS: Record<string, string> = {
  queued: '排队等待',
  extracting: '接收视频',
  beat_detecting: '检测节拍 (BPM)',
  segmenting: '按 8 拍分段',
  done: '生成节拍标注',
}

export default function AnalysisPage() {
  const { taskId } = useParams<{ taskId: string }>()
  const location = useLocation()
  const navigate = useNavigate()
  const videoId = (location.state as { videoId?: string } | null)?.videoId ?? taskId ?? ''
  const { status, error, loading, retry } = useAnalysisPolling(taskId)

  useEffect(() => {
    if (status?.status === 'done') {
      navigate(`/lesson/${taskId}`, { state: { videoId } })
    }
  }, [status, taskId, videoId, navigate])

  const currentIdx = status ? STEP_ORDER.indexOf(status.status as TaskStatusValue) : 0
  const progress = status?.progress ?? 0

  return (
    <Container maxWidth="sm" sx={{ py: 10, textAlign: 'center' }}>
      <Typography variant="h4" fontWeight={700} gutterBottom>
        正在为你拆解舞蹈…
      </Typography>
      {loading && !status && <CircularProgress sx={{ my: 4 }} />}

      {status && (
        <>
          <Typography variant="h3" fontWeight={800} color="primary">
            {progress}%
          </Typography>
          <LinearProgress
            variant="determinate"
            value={progress}
            sx={{ my: 3, height: 8, borderRadius: 4 }}
          />
          <Stack
            spacing={1.5}
            alignItems="flex-start"
            sx={{ maxWidth: 280, mx: 'auto', mt: 2 }}
          >
            {STEP_ORDER.filter((s) => s !== 'queued').map((step) => {
              const idx = STEP_ORDER.indexOf(step)
              const done = currentIdx > idx || status.status === 'done'
              const active = currentIdx === idx && status.status !== 'done'
              return (
                <Stack key={step} direction="row" spacing={1.5} alignItems="center">
                  <Box sx={{ width: 24, textAlign: 'center', fontWeight: 700 }}>
                    {done ? '✓' : active ? '⟳' : '○'}
                  </Box>
                  <Typography
                    color={done ? 'text.primary' : active ? 'primary.main' : 'text.disabled'}
                  >
                    {STEP_LABELS[step]}
                  </Typography>
                </Stack>
              )
            })}
          </Stack>
        </>
      )}

      {status?.status === 'failed' && (
        <Box sx={{ mt: 4 }}>
          <Typography color="error">分析失败：{status.error ?? '未知错误'}</Typography>
          <Button variant="contained" sx={{ mt: 2 }} onClick={retry}>
            重试
          </Button>
        </Box>
      )}

      {error && (
        <Typography color="error" sx={{ mt: 2 }}>
          {error}
        </Typography>
      )}
    </Container>
  )
}
