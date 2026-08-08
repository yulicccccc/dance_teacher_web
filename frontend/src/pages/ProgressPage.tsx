import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import {
  Box,
  Button,
  Card,
  CardActionArea,
  CardContent,
  Container,
  Grid,
  Typography,
} from '@mui/material'
import { useLocalProgress, type CourseProgress } from '../hooks/useLocalProgress'
import { formatDuration } from '../utils/format'

export default function ProgressPage() {
  const navigate = useNavigate()
  const { ready, getAll } = useLocalProgress()
  const [courses, setCourses] = useState<Record<string, CourseProgress>>({})

  useEffect(() => {
    if (ready) setCourses({ ...getAll() })
  }, [ready, getAll])

  const list = Object.entries(courses)
  const totalLearned = list.reduce(
    (sum, [, c]) => sum + c.progress.learnedSegments.length,
    0,
  )
  const totalPracticeSeconds = list.reduce(
    (sum, [, course]) => sum + course.progress.practiceSeconds,
    0,
  )

  return (
    <Container maxWidth="md" sx={{ py: 6 }}>
      <Typography variant="h4" fontWeight={700} gutterBottom>
        我的课程
      </Typography>
      {list.length === 0 && (
        <Typography color="text.secondary" sx={{ mt: 4 }}>
          还没有课程，去上传一个舞蹈视频开始学习吧。
        </Typography>
      )}
      <Grid container spacing={2} sx={{ mt: 1 }}>
        {list.map(([vid, c]) => {
          const total = c.result.segments.length
          const learned = c.progress.learnedSegments.length
          const all = total > 0 && learned >= total
          const completion = total > 0 ? Math.round((learned / total) * 100) : 0
          return (
            <Grid item xs={12} sm={6} md={4} key={vid}>
              <Card>
                <CardActionArea
                  onClick={() => navigate(`/lesson/${c.taskId}`, { state: { videoId: vid } })}
                >
                  <CardContent>
                    <Typography variant="h6" noWrap>
                      {c.videoName}
                    </Typography>
                    <Typography color={all ? 'success.main' : 'text.secondary'}>
                      {learned}/{total} 小节 · {completion}% {all ? '✓' : ''}
                    </Typography>
                    <Typography variant="body2" color="text.secondary" sx={{ mt: 1 }}>
                      当前：第 {c.progress.currentSegment} 节
                    </Typography>
                  </CardContent>
                </CardActionArea>
              </Card>
            </Grid>
          )
        })}
      </Grid>
      <Box sx={{ mt: 4 }}>
        <Typography variant="body2" color="text.secondary">
          统计：已学会 {totalLearned} 个小节 · 累计练习 {formatDuration(totalPracticeSeconds)} · 共 {list.length} 支舞
        </Typography>
        <Button sx={{ mt: 2 }} variant="contained" onClick={() => navigate('/')}>
          上传新视频
        </Button>
      </Box>
    </Container>
  )
}
