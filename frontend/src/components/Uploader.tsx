import { useRef, useState } from 'react'
import {
  Box,
  Button,
  LinearProgress,
  Paper,
  Stack,
  TextField,
  Typography,
} from '@mui/material'
import UploadFileIcon from '@mui/icons-material/UploadFile'
import LinkIcon from '@mui/icons-material/Link'
import { http } from '../api/client'
import type { UploadResponse } from '../types/api'

interface Props {
  onUploaded: (taskId: string, videoId: string) => void
  onError: (msg: string) => void
}

function formatSize(bytes: number): string {
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

/** Stable per-video id so progress survives re-uploads of the same file. */
function computeVideoId(file: File | null, url: string): string {
  const raw = file ? `${file.name}:${file.size}:${file.lastModified}` : url || String(Math.random())
  let h = 0
  for (let i = 0; i < raw.length; i++) h = (h * 31 + raw.charCodeAt(i)) | 0
  return `v${h >>> 0}`
}

export default function Uploader({ onUploaded, onError }: Props) {
  const [file, setFile] = useState<File | null>(null)
  const [url, setUrl] = useState('')
  const [uploading, setUploading] = useState(false)
  const [progress, setProgress] = useState(0)
  const inputRef = useRef<HTMLInputElement>(null)

  const handleSelect = (files: FileList | null) => {
    if (files && files.length > 0) {
      const f = files[0]
      setFile(f)
      setUrl('')
    }
  }

  const submit = async () => {
    setUploading(true)
    setProgress(file ? 0 : 100)
    try {
      let resp: UploadResponse
      if (file) {
        const form = new FormData()
        form.append('file', file)
        const { data } = await http.post<UploadResponse>('/upload', form, {
          headers: { 'Content-Type': 'multipart/form-data' },
          onUploadProgress: (e) => {
            if (e.total) setProgress(Math.round((e.loaded / e.total) * 100))
          },
        })
        resp = data
      } else if (url.trim()) {
        const { data } = await http.post<UploadResponse>('/upload', { url: url.trim() })
        resp = data
      } else {
        onError('请选择本地视频或粘贴视频链接')
        setUploading(false)
        return
      }
      onUploaded(resp.taskId, computeVideoId(file, url))
    } catch (e) {
      const err = e as { response?: { data?: { message?: string } }; message?: string }
      onError(err?.response?.data?.message ?? err?.message ?? '上传失败')
    } finally {
      setUploading(false)
    }
  }

  return (
    <Stack spacing={3} alignItems="center">
      <Paper
        variant="outlined"
        sx={{
          width: '100%',
          p: 4,
          borderStyle: 'dashed',
          borderWidth: 2,
          cursor: 'pointer',
          textAlign: 'center',
        }}
        onClick={() => inputRef.current?.click()}
        onDragOver={(e) => e.preventDefault()}
        onDrop={(e) => {
          e.preventDefault()
          handleSelect(e.dataTransfer.files)
        }}
      >
        <input
          ref={inputRef}
          type="file"
          accept="video/mp4,video/webm,video/quicktime"
          hidden
          onChange={(e) => handleSelect(e.target.files)}
        />
        <UploadFileIcon sx={{ fontSize: 48, color: 'primary.main' }} />
        <Typography variant="h6" sx={{ mt: 1 }}>
          拖拽视频到此处 / 点击选择文件
        </Typography>
        <Typography variant="body2" color="text.secondary">
          支持 mp4 / webm / mov（≤500MB，≤10 分钟）
        </Typography>
      </Paper>

      {file && (
        <Box sx={{ width: '100%' }}>
          <Stack direction="row" spacing={1} alignItems="center">
            <UploadFileIcon fontSize="small" />
            <Typography variant="body2" noWrap>
              {file.name}
            </Typography>
            <Typography variant="body2" color="text.secondary">
              （{formatSize(file.size)}）
            </Typography>
          </Stack>
          {uploading && <LinearProgress variant="determinate" value={progress} sx={{ mt: 1 }} />}
        </Box>
      )}

      <Stack direction="row" spacing={1} alignItems="center" sx={{ width: '100%' }}>
        <LinkIcon color="action" />
        <TextField
          fullWidth
          size="small"
          placeholder="或粘贴视频链接（可选）"
          value={url}
          disabled={!!file}
          onChange={(e) => setUrl(e.target.value)}
        />
      </Stack>

      <Button
        variant="contained"
        size="large"
        disabled={uploading || (!file && !url.trim())}
        onClick={submit}
        sx={{ minWidth: 200 }}
      >
        {uploading ? '正在上传…' : '开始分析'}
      </Button>
    </Stack>
  )
}
