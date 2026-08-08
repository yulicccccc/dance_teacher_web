import { useEffect } from 'react'
import { useLocation, useNavigate, useParams } from 'react-router-dom'
import { Box, Button, Container, LinearProgress, Stack, Typography } from '@mui/material'
import { useLocalAnalysis } from '../hooks/useLocalAnalysis'
import { retryLocalAnalysis, recomputeLocalTask } from '../api/localAnalysis'
import EngineLoadingHint from '../components/EngineLoadingHint'

const STEP_LABELS: Record<string, string> = {
  queued: '排队等待',
  extracting: '接收视频',
  beat_detecting: '检测节拍 (BPM)',
  segmenting: '按 8 拍分段',
  done: '生成节拍标注',
}
const ORDER = ['queued', 'extracting', 'beat_detecting', 'segmenting', 'done']

export default function AnalysisPage() {
  const { taskId } = useParams<{ taskId: string }>()
  const location = useLocation()
  const navigate = useNavigate()
  const videoId = (location.state as { videoId?: string } | null)?.videoId ?? taskId ?? ''
  const { task } = useLocalAnalysis(taskId)

  useEffect(() => {
    if (task?.status === 'done') {
      navigate(`/lesson/${taskId}`, { state: { videoId } })
    }
  }, [task?.status, taskId, videoId, navigate])

  const status = task?.status ?? 'queued'
  const progress = task?.progress ?? 0

  return (
    <Container maxWidth="sm" sx={{ py: 10, textAlign: 'center' }}>
      <Typography variant="h4" fontWeight={700} gutterBottom>
        正在为你拆解舞蹈…
      </Typography>

      <Typography variant="h3" fontWeight={800} color="primary" sx={{ my: 2 }}>
        {progress}%
      </Typography>
      <LinearProgress
        variant="determinate"
        value={progress}
        sx={{ my: 3, height: 8, borderRadius: 4 }}
      />

      <Stack spacing={1.5} alignItems="flex-start" sx={{ maxWidth: 280, mx: 'auto' }}>
        {ORDER.filter((s) => s !== 'queued').map((step) => {
          const idx = ORDER.indexOf(step)
          const curIdx = ORDER.indexOf(status)
          const done = curIdx > idx || status === 'done'
          const active = curIdx === idx && status !== 'done'
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

      {status === 'failed' && (
        <Box sx={{ mt: 4 }}>
          <Typography color="error">分析失败：{task?.error ?? '未知错误'}</Typography>
          <Stack direction="row" spacing={2} justifyContent="center" sx={{ mt: 2 }}>
            <Button variant="contained" onClick={() => taskId && void retryLocalAnalysis(taskId)}>
              重试
            </Button>
            <Button
              variant="outlined"
              onClick={async () => {
                if (!taskId) return
                try {
                  await recomputeLocalTask(taskId, { mode: 'fixed120' })
                  navigate(`/lesson/${taskId}`, { state: { videoId } })
                } catch {
                  /* ignore — retry remains available */
                }
              }}
            >
              用 120 BPM 继续
            </Button>
          </Stack>
        </Box>
      )}

      {status !== 'failed' && status !== 'done' && (
        <EngineLoadingHint label="本地引擎运行中…" />
      )}
    </Container>
  )
}
