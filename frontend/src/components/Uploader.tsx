import { useRef, useState } from 'react'
import {
  Box,
  Button,
  LinearProgress,
  Paper,
  Stack,
  Typography,
} from '@mui/material'
import UploadFileIcon from '@mui/icons-material/UploadFile'
import { validateVideoFile } from '../utils/mediaValidate'

interface Props {
  onStart: (file: File) => void
  onError: (msg: string) => void
}

function formatSize(bytes: number): string {
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

/**
 * Local-first file picker. No URL entry, no network — selecting a file and
 * clicking 「开始分析」 hands the File to the caller, which runs the whole
 * analysis pipeline in the browser.
 */
export default function Uploader({ onStart, onError }: Props) {
  const [file, setFile] = useState<File | null>(null)
  const [busy, setBusy] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)

  const handleSelect = (files: FileList | null) => {
    if (files && files.length > 0) setFile(files[0])
  }

  const submit = () => {
    if (!file) {
      onError('请选择一个舞蹈视频文件')
      return
    }
    const v = validateVideoFile(file)
    if (!v.ok) {
      onError(v.message ?? '文件不符合要求')
      return
    }
    setBusy(true)
    try {
      onStart(file)
    } finally {
      setBusy(false)
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
          {busy && <LinearProgress sx={{ mt: 1 }} />}
        </Box>
      )}

      <Button
        variant="contained"
        size="large"
        disabled={busy || !file}
        onClick={submit}
        sx={{ minWidth: 200 }}
      >
        {busy ? '正在准备…' : '开始分析'}
      </Button>
    </Stack>
  )
}
