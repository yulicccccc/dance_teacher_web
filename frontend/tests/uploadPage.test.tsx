// UploadPage (zero-server build) renders the local-first entry: upload heading
// + offline demo button, and performs NO backend warm-up.
import { describe, it, expect } from 'vitest'
import { createRoot } from 'react-dom/client'
import { act } from 'react'
import { MemoryRouter } from 'react-router-dom'
import UploadPage from '../src/pages/UploadPage'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

describe('UploadPage — local-first entry', () => {
  it('renders the upload heading and the offline demo button (no backend warm-up)', () => {
    const container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)
    act(() => {
      root.render(
        <MemoryRouter>
          <UploadPage />
        </MemoryRouter>,
      )
    })
    expect(container.textContent).toContain('上传你的舞蹈视频')
    expect(container.textContent).toContain('试用示例（无需上传）')
    // The zero-server build never shows a backend warm-up indicator.
    expect(container.textContent).not.toContain('正在唤醒服务器')
    root.unmount()
    container.remove()
  })
})
