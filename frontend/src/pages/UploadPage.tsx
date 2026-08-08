import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { AppBar, Box, Button, Container, Toolbar, Typography } from '@mui/material'
import Uploader from '../components/Uploader'
import { registerVideo } from '../storage/videoRegistry'
import { startLocalAnalysis } from '../api/localAnalysis'
import { buildDemoResult } from '../demo/sampleLesson'

export default function UploadPage() {
  const navigate = useNavigate()
  const [error, setError] = useState<string | null>(null)
  const [analyzing, setAnalyzing] = useState(false)

  // Kick off the entire pipeline in the browser, then move to the progress page.
  const handleStart = (file: File) => {
    setError(null)
    setAnalyzing(true)
    void (async () => {
      try {
        const videoId = await registerVideo(file)
        const taskId = await startLocalAnalysis(file, videoId)
        navigate(`/analyze/${taskId}`, { state: { videoId } })
      } catch (e) {
        setAnalyzing(false)
        setError(e instanceof Error ? e.message : '分析失败，请重试')
      }
    })()
  }

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
          视频全程在你的浏览器本地分析，不上传任何服务器，拆好 8 拍小节后即可像舞室老师一样一小节一小节带练。
        </Typography>
        {analyzing && (
          <Typography variant="caption" color="text.secondary" sx={{ mb: 1 }}>
            正在本地分析节拍，请稍候…
          </Typography>
        )}
        <Uploader
          onStart={handleStart}
          onError={(m) => {
            setError(m)
            setAnalyzing(false)
          }}
        />
        <Button
          variant="outlined"
          fullWidth
          sx={{ mt: 2 }}
          disabled={analyzing}
          onClick={() =>
            navigate('/lesson/demo', { state: { demoResult: buildDemoResult(), videoId: 'demo' } })
          }
        >
          试用示例（无需上传）
        </Button>
        <Typography variant="caption" color="text.secondary" sx={{ mt: 1, display: 'block' }}>
          内置示例拍点，可离线测试所有交互
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
