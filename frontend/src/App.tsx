import { Navigate, Route, Routes } from 'react-router-dom'
import UploadPage from './pages/UploadPage'
import AnalysisPage from './pages/AnalysisPage'
import LessonPage from './pages/LessonPage'
import ProgressPage from './pages/ProgressPage'

export default function App() {
  return (
    <Routes>
      <Route path="/" element={<UploadPage />} />
      <Route path="/analyze/:taskId" element={<AnalysisPage />} />
      <Route path="/lesson/:taskId" element={<LessonPage />} />
      <Route path="/progress" element={<ProgressPage />} />
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  )
}
