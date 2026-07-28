import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import {
  AppBar,
  Box,
  Button,
  Container,
  Toolbar,
  Typography,
} from '@mui/material'
import Uploader from '../components/Uploader'
import { isLikelyDesktop } from '../analysis/crossOrigin'

export default function UploadPage() {
  const navigate = useNavigate()
  const [error, setError] = useState<string | null>(null)
  const [desktopWarning, setDesktopWarning] = useState(false)

  useEffect(() => {
    // Soft hint only — the analysis still attempts to run everywhere.
    setDesktopWarning(!isLikelyDesktop())
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
        <Typography color="text.secondary" sx={{ mb: 2 }}>
          上传后网站会自动按 8 拍拆成小节，像舞室老师一样一小节一小节带练。
        </Typography>

        <Box
          sx={{
            mb: 3,
            p: 2,
            borderRadius: 2,
            bgcolor: 'rgba(34,211,238,0.08)',
            border: '1px solid',
            borderColor: 'rgba(34,211,238,0.3)',
          }}
        >
          <Typography variant="body2" color="text.secondary">
            🔒 隐私说明：视频仅在你的浏览器内处理，不上传任何服务器。
          </Typography>
        </Box>

        {desktopWarning && (
          <Typography
            variant="caption"
            color="warning.main"
            sx={{ display: 'block', mb: 2 }}
          >
            建议使用桌面版 Chrome / Edge / Firefox 以获得最佳分析性能（移动端对
            WASM / SharedArrayBuffer 支持有限）。
          </Typography>
        )}

        <Uploader
          onUploaded={(videoId) =>
            navigate(`/analyze/${videoId}`, { state: { videoId } })
          }
          onError={setError}
        />

        {error && (
          <Typography color="error" sx={{ mt: 2 }}>
            {error}
          </Typography>
        )}
      </Container>
    </Box>
  )
}
