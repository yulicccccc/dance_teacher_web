import { describe, it, expect } from 'vitest'
import { createRef, useState, type RefObject } from 'react'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { usePlayPauseSync } from '../src/hooks/usePlayPauseSync'
import type { Segment } from '../src/types/api'

// Flag the React act() environment so state updates flush correctly.
;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

function makeSegments(): Segment[] {
  return [
    { index: 1, startTime: 0, endTime: 4, type: 'dance', beats: [0, 0.5, 1, 1.5, 2, 2.5, 3, 3.5] },
    { index: 2, startTime: 4, endTime: 8, type: 'dance', beats: [4, 4.5, 5, 5.5, 6, 6.5, 7, 7.5] },
  ]
}

function Harness({ videoRef, segments }: { videoRef: RefObject<HTMLVideoElement>; segments: Segment[] }) {
  const [playing, setPlaying] = useState(false)
  usePlayPauseSync(videoRef, segments, setPlaying)
  return <span data-testid="flag" data-playing={String(playing)} />
}

function flag(container: HTMLElement): string {
  return (container.querySelector('[data-testid="flag"]') as HTMLElement).getAttribute('data-playing') as string
}

describe('Bug C: play/pause listeners attach after the <video> mounts', () => {
  it('flips the playing flag when play/pause fire on the mounted <video>', () => {
    const videoRef = createRef<HTMLVideoElement>()
    const container = document.createElement('div')
    document.body.appendChild(container)
    const root: Root = createRoot(container)

    // 1) No result yet: segments=[] -> <video> not mounted -> listeners NOT attached.
    act(() => {
      root.render(<Harness videoRef={videoRef} segments={[]} />)
    })

    // 2) Result arrives + <video> mounts. The `segments` dependency changes, so
    //    usePlayPauseSync re-runs and attaches the real play/pause listeners.
    act(() => {
      root.render(
        <>
          <video ref={videoRef} data-testid="vid" />
          <Harness videoRef={videoRef} segments={makeSegments()} />
        </>,
      )
    })
    const video = container.querySelector('[data-testid="vid"]') as HTMLVideoElement
    expect(video).toBeTruthy()
    expect(flag(container)).toBe('false') // jsdom video.readyState is 0 -> no immediate sync

    act(() => {
      video.dispatchEvent(new Event('play'))
    })
    expect(flag(container)).toBe('true')
    act(() => {
      video.dispatchEvent(new Event('pause'))
    })
    expect(flag(container)).toBe('false')

    root.unmount()
    container.remove()
  })

  it('does NOT flip before the video mounts (guards the old [videoRef]-only bug)', () => {
    const videoRef = createRef<HTMLVideoElement>()
    const container = document.createElement('div')
    document.body.appendChild(container)
    const root: Root = createRoot(container)
    act(() => {
      root.render(<Harness videoRef={videoRef} segments={[]} />)
    })

    // Manually create a video and fire events WITHOUT a re-render that would
    // attach listeners — mirrors the old bug where deps=[videoRef] never re-ran.
    const video = document.createElement('video')
    videoRef.current = video
    act(() => {
      video.dispatchEvent(new Event('play'))
    })
    expect(flag(container)).toBe('false')

    root.unmount()
    container.remove()
  })
})
