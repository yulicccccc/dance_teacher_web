import { useEffect, useRef } from 'react'
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
import { useAnalyzer } from '../analysis/useAnalyzer'
import { useUploadSession } from '../store/uploadSession'

const PHASE_LABELS: Record<string, string> = {
  loading_engine: '加载分析引擎 (ffmpeg.wasm + essentia.js)',
  extracting: '提取音轨 (ffmpeg.wasm)',
  detecting: '检测节拍 / BPM (essentia.js)',
  segmenting: '按 8 拍分段',
  done: '生成节拍标注',
}

const PHASE_ORDER = [
  'loading_engine',
  'extracting',
  'detecting',
  'segmenting',
  'done',
]

export default function AnalysisPage() {
  const { taskId } = useParams<{ taskId: string }>()
  const location = useLocation()
  const navigate = useNavigate()
  const videoId = (location.state as { videoId?: string } | null)?.videoId ?? taskId ?? ''
  const { videoFile, videoName } = useUploadSession()
  const { phase, progress, error, start, cancel } = useAnalyzer()
  const startedRef = useRef(false)

  useEffect(() => {
    if (startedRef.current || !videoFile) return
    startedRef.current = true
    void start(videoFile, videoId, videoName)
  }, [videoFile, videoId, videoName, start])

  useEffect(() => {
    if (phase === 'done' && videoId) {
      navigate(`/lesson/${videoId}`, { state: { videoId } })
    }
  }, [phase, videoId, navigate])

  useEffect(() => {
    if (phase === 'cancelled') navigate('/', { replace: true })
  }, [phase, navigate])

  if (!videoFile) {
    return (
      <Container sx={{ py: 10, textAlign: 'center' }}>
        <Typography>未找到待分析视频，请重新上传。</Typography>
        <Button sx={{ mt: 2 }} variant="contained" onClick={() => navigate('/')}>
          返回上传
        </Button>
      </Container>
    )
  }

  const currentIdx = PHASE_ORDER.indexOf(phase)
  const errored = phase === 'error'

  return (
    <Container maxWidth="sm" sx={{ py: 10, textAlign: 'center' }}>
      <Typography variant="h4" fontWeight={700} gutterBottom>
        正在为你拆解舞蹈…
      </Typography>

      {errored ? (
        <CircularProgress sx={{ my: 4 }} />
      ) : (
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
            sx={{ maxWidth: 360, mx: 'auto', mt: 2 }}
          >
            {PHASE_ORDER.map((step) => {
              const idx = PHASE_ORDER.indexOf(step)
              const done = currentIdx > idx || phase === 'done'
              const active = currentIdx === idx && phase !== 'done'
              return (
                <Stack key={step} direction="row" spacing={1.5} alignItems="center">
                  <Box sx={{ width: 24, textAlign: 'center', fontWeight: 700 }}>
                    {done ? '✓' : active ? '⟳' : '○'}
                  </Box>
                  <Typography
                    color={
                      done ? 'text.primary' : active ? 'primary.main' : 'text.disabled'
                    }
                  >
                    {PHASE_LABELS[step]}
                  </Typography>
                </Stack>
              )
            })}
          </Stack>
        </>
      )}

      {errored && (
        <Box sx={{ mt: 4 }}>
          <Typography color="error">分析失败：{error ?? '未知错误'}</Typography>
          <Button
            variant="contained"
            sx={{ mt: 2 }}
            onClick={() => {
              startedRef.current = false
              void start(videoFile, videoId, videoName)
            }}
          >
            重试
          </Button>
          <Button sx={{ mt: 2, ml: 1 }} onClick={() => navigate('/')}>
            返回上传
          </Button>
        </Box>
      )}

      {!errored && phase !== 'done' && phase !== 'cancelled' && (
        <Button sx={{ mt: 4 }} color="inherit" onClick={cancel}>
          取消
        </Button>
      )}
    </Container>
  )
}
