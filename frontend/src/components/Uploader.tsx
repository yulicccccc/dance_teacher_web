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
import { useUploadSession } from '../store/uploadSession'
import { cacheVideo } from '../store/videoCache'

const MAX_SIZE = 500 * 1024 * 1024 // 500MB
const MAX_DURATION = 10 * 60 // 10 minutes

interface Props {
  onUploaded: (videoId: string) => void
  onError: (msg: string) => void
}

function computeVideoId(file: File): string {
  const raw = `${file.name}:${file.size}:${file.lastModified}`
  let h = 0
  for (let i = 0; i < raw.length; i++) h = (h * 31 + raw.charCodeAt(i)) | 0
  return `v${h >>> 0}`
}

function formatSize(bytes: number): string {
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

/**
 * Best-effort video duration probe. Returns `null` if metadata can't load
 * (e.g. in a test environment with no real decoder) so the upload is never
 * hard-blocked by the probe itself.
 */
function getVideoDuration(url: string, timeoutMs = 2000): Promise<number | null> {
  return new Promise((resolve) => {
    const v = document.createElement('video')
    let done = false
    const finish = (d: number | null) => {
      if (done) return
      done = true
      v.remove()
      resolve(d)
    }
    const t = setTimeout(() => finish(null), timeoutMs)
    v.preload = 'metadata'
    v.onloadedmetadata = () => {
      clearTimeout(t)
      finish(Number.isFinite(v.duration) ? v.duration : null)
    }
    v.onerror = () => {
      clearTimeout(t)
      finish(null)
    }
    v.src = url
  })
}

/**
 * Local-only uploader. The video never leaves the browser: we compute a stable
 * `videoId`, cache the `File` in IndexedDB for later replay, store it in the
 * upload session (which creates a local object URL for playback), then notify
 * the parent. No HTTP / axios / backend involved.
 */
export default function Uploader({ onUploaded, onError }: Props) {
  const [file, setFile] = useState<File | null>(null)
  const [submitting, setSubmitting] = useState(false)
  const [progress, setProgress] = useState(0)
  const inputRef = useRef<HTMLInputElement>(null)
  const setFileSession = useUploadSession((s) => s.setFile)

  const handleSelect = (files: FileList | null) => {
    if (files && files.length > 0) {
      setFile(files[0])
      setProgress(0)
    }
  }

  const submit = async () => {
    if (!file) {
      onError('请选择一个本地视频文件')
      return
    }
    if (file.size > MAX_SIZE) {
      onError('视频过大（请控制在 500MB 以内）')
      return
    }

    setSubmitting(true)
    try {
      const probeUrl = URL.createObjectURL(file)
      const dur = await getVideoDuration(probeUrl)
      URL.revokeObjectURL(probeUrl)
      if (dur != null && dur > MAX_DURATION) {
        onError('视频过长（请控制在 10 分钟以内）')
        setSubmitting(false)
        return
      }

      const videoId = computeVideoId(file)
      // Cache the file so the lesson page can replay it later without re-upload.
      await cacheVideo(videoId, file)
      setFileSession(file, videoId, file.name)
      setProgress(100)
      onUploaded(videoId)
    } catch (e) {
      onError((e as Error)?.message ?? '无法处理该视频，请重试')
    } finally {
      setSubmitting(false)
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
          {submitting && (
            <LinearProgress
              variant={progress > 0 ? 'determinate' : 'indeterminate'}
              value={progress}
              sx={{ mt: 1 }}
            />
          )}
        </Box>
      )}

      <Button
        variant="contained"
        size="large"
        disabled={submitting || !file}
        onClick={submit}
        sx={{ minWidth: 200 }}
      >
        {submitting ? '准备中…' : '开始分析'}
      </Button>
    </Stack>
  )
}
