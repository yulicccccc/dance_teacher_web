import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { AppBar, Box, Button, Container, Toolbar, Typography } from '@mui/material'
import Uploader from '../components/Uploader'
import { apiClient } from '../api/client'
import { buildDemoResult } from '../demo/sampleLesson'

export default function UploadPage() {
  const navigate = useNavigate()
  const [error, setError] = useState<string | null>(null)
  const [warming, setWarming] = useState(false)

  useEffect(() => {
    // Fire-and-forget backend warm-up (Render cold start). Result is ignored.
    setWarming(true)
    void apiClient.warmup().finally(() => setWarming(false))
  }, [])

  return (
    <Box sx={{ minHeight: '100vh', bgcolor: 'background.default' }}>
      <AppBar position="static" color="transparent" elevation={0}>
        <Toolbar>
          <Typography variant="h6" sx={{ flexGrow: 1, fontWeight: 700 }}>
            🩰 舞蹈老师
          </Typography>
          <Button onClick={() => navigate('/progress')}>我的课程</Button>
        </Toolbar>
      </AppBar>
      <Container maxWidth="sm" sx={{ py: 8 }}>
        <Typography variant="h4" fontWeight={700} gutterBottom>
          上传你的舞蹈视频
        </Typography>
        <Typography color="text.secondary" sx={{ mb: 4 }}>
          视频会分片上传到本站服务器做高精度节拍分析，再自动按 8 拍拆成小节；不会交给第三方。
        </Typography>
        {warming && (
          <Typography variant="caption" color="text.secondary" sx={{ mb: 1 }}>
            正在唤醒服务器…
          </Typography>
        )}
        <Uploader
          onUploaded={(taskId, videoId) => navigate(`/analyze/${taskId}`, { state: { videoId } })}
          onError={setError}
        />
        <Button
          variant="outlined"
          fullWidth
          sx={{ mt: 2 }}
          onClick={() =>
            navigate('/lesson/demo', {
              state: { demoResult: buildDemoResult(), videoId: 'demo' },
            })
          }
        >
          试用示例（无需上传）
        </Button>
        <Typography variant="caption" color="text.secondary" sx={{ mt: 1, display: 'block' }}>
          内置示例拍点，可测试六档循环和全部教学交互
        </Typography>
        {error && (
          <Typography color="error" sx={{ mt: 2 }}>
            {error}
          </Typography>
        )}
      </Container>
    </Box>
  )
}
