import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createRef, type RefObject } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react'
import { useBeatSync } from '../src/hooks/useBeatSync'
import type { Segment } from '../src/types/api'

// Flag the React act() environment so state updates inside rAF flush correctly.
;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

// ---- rAF control: capture the single callback so we can step frames manually.
type RafCb = (t: number) => void
let rafQueue: RafCb[] = []
const realRaf = globalThis.requestAnimationFrame
const realCaf = globalThis.cancelAnimationFrame
beforeEach(() => {
  rafQueue = []
  globalThis.requestAnimationFrame = ((cb: RafCb) => {
    rafQueue.push(cb)
    return rafQueue.length
  }) as unknown as typeof requestAnimationFrame
  globalThis.cancelAnimationFrame = (() => {}) as typeof cancelAnimationFrame
})
afterEach(() => {
  globalThis.requestAnimationFrame = realRaf
  globalThis.cancelAnimationFrame = realCaf
})
function flushRaf() {
  const cbs = rafQueue
  rafQueue = []
  for (const cb of cbs) cb()
}
function step() {
  act(() => {
    flushRaf()
  })
}

// 5 contiguous 8-beat segments @ 120 BPM (0.5s/beat), 4s each.
// Segment 2 = [4, 8), padded loop window [3.5, 8.5) -> loopStart 3.5.
// Segment 3 = [8, 12), padded loop window [7.5, 12.5) -> loopStart 7.5.
function makeSegments(): Segment[] {
  return Array.from({ length: 5 }, (_, i) => {
    const start = i * 4
    return {
      index: i + 1,
      startTime: start,
      endTime: start + 4,
      type: 'dance',
      beats: Array.from({ length: 8 }, (_, k) => start + k * 0.5),
    }
  })
}

interface Props {
  videoRef: RefObject<HTMLVideoElement>
  segments: Segment[]
  loop: boolean
  offset: number
  beatDuration: number
}
function Harness(props: Props) {
  useBeatSync(props.videoRef, props.segments, props.loop, props.offset, props.beatDuration)
  return null
}

// jsdom clamps currentTime on an unloaded <video>, so we back it with a plain
// variable and record every assignment in `timeLog`. timeLog captures BOTH our
// own drive writes AND the loop's seek targets, so inside `drive` we clear it
// AFTER setting currentTime and BEFORE `step()`, so only the loop's own seek (if
// any) survives for that frame. Each engine seek is reported via `onSeek`.
function makeVideo() {
  let current = 0
  const timeLog: number[] = []
  const video = document.createElement('video') as HTMLVideoElement & { __timeLog: number[] }
  Object.defineProperty(video, 'currentTime', {
    configurable: true,
    get: () => current,
    set: (v: number) => {
      current = v
      timeLog.push(v)
    },
  })
  video.__timeLog = timeLog
  video.play = vi.fn(() => Promise.resolve()) as unknown as HTMLMediaElement['play']
  video.pause = vi.fn() as unknown as HTMLMediaElement['pause']
  return { video, timeLog }
}

function setup(props: Omit<Props, 'videoRef'>) {
  const videoRef = createRef<HTMLVideoElement>()
  const { video, timeLog } = makeVideo()
  videoRef.current = video
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root: Root = createRoot(container)
  act(() => {
    root.render(<Harness {...props} videoRef={videoRef} />)
  })
  return { videoRef, video, timeLog, root, container }
}

// Advance the playhead in small steps, honouring any loop-back seek the engine
// performs (so the loop actually cycles). Every engine seek is reported via
// `onSeek` (drive writes are discarded). Returns nothing; rely on `onSeek`.
//
// The playhead position is a running value rounded to 5 decimals (like the
// other loop tests) so float accumulation never pushes the crossing frame's
// `prev` past loopEnd - EPS and silently skips the loop seam. Each frame the
// actual playhead is read back so a loop-back seek restarts the ramp from the
// looped position.
function drive(
  video: HTMLVideoElement & { __timeLog: number[] },
  timeLog: number[],
  fromT: number,
  frames: number,
  stepSize: number,
  onSeek?: (t: number) => void,
) {
  let position = fromT
  for (let i = 0; i < frames; i++) {
    position = Number((position + stepSize).toFixed(5))
    act(() => {
      video.currentTime = position
    })
    // Discard our own drive write; only the engine's loop seek survives.
    timeLog.length = 0
    step()
    for (const x of timeLog) onSeek?.(x)
    // Honour a loop-back the engine performed this frame.
    position = (video as unknown as { currentTime: number }).currentTime
  }
}

describe('单节循环上升沿 — 启用即锁定当前小节（Bug: 偶尔锁定到下一节）', () => {
  it('在某一节中间启用循环 → 锁定并循环的是当前所在小节，而非下一节', () => {
    // 播放头停在 segment 2 正中央 (t=6.0)。启用单节循环后：
    //   * 上升沿立即把 loopTarget 锁到 segment 2；
    //   * 播放头越过本节扩展 loopEnd(8.5) 后回到 segment 2 的 padded loopStart
    //     (3.5)，而不是跳到下一节 segment 3 的 loopStart (7.5)。
    const { video, timeLog, root, container } = setup({
      segments: makeSegments(),
      loop: true,
      offset: 0,
      beatDuration: 0.5,
    })
    act(() => {
      video.currentTime = 6.0
      video.dispatchEvent(new Event('seeked'))
    })
    step()

    let sawCurrent = false
    let sawNext = false
    drive(video, timeLog, 6.0, 3000, 0.01, (x) => {
      if (Math.abs(x - 3.5) < 1e-3) sawCurrent = true
      if (Math.abs(x - 7.5) < 1e-3) sawNext = true
    })
    expect(sawCurrent).toBe(true)
    expect(sawNext).toBe(false)
    root.unmount()
    container.remove()
  })

  it('在靠近本节末端的「边界盲区」启用循环也锁定当前小节（真正的回归护栏）', () => {
    // 构造确定性可区分场景：播放头停在 segment 2 末端之前的「边界盲区」
    // (t=7.9995，即 endTime(8.0) 减去 LOOP_EPS 之内)。此处 locateBeat 仍判定为
    // segment 2，但旧的 computeLoopSegment 边界检测在跨过 8.0 的那一帧会因为
    // prev(7.9995) >= 8.0 - EPS 而「错过」本节边界，于是迟迟锁不到目标、要等到
    // 跨过下一节末(12.0)才锁定 —— 循环的是下一节。
    //
    // 上升沿修复会在启用瞬间就把 loopTarget 锁到 segment 2（不依赖任何边界跨越），
    // 因此一旦越过扩展 loopEnd(8.5) 就回到 loopStart(3.5)。
    //
    // 下面用两帧推进精确复现「启用 → 跨过 8.0 → 跨过 8.5」：
    //   - 旧逻辑：computeLoopSegment 在 8.0 那一帧漏检，且 8.5 帧仍无目标，永不回 3.5；
    //   - 新逻辑：启用即锁 seg2，跨过 8.5 即回 3.5。
    // 该用例在「旧逻辑」下断言失败，是真正的回归护栏。
    const { video, timeLog, root, container } = setup({
      segments: makeSegments(),
      loop: true,
      offset: 0,
      beatDuration: 0.5,
    })
    act(() => {
      video.currentTime = 7.9995
      video.dispatchEvent(new Event('seeked'))
    })
    step()

    // 帧 1：跨过 8.0（prev=7.9995 >= 8.0 - EPS，旧逻辑漏检）。
    act(() => {
      video.currentTime = 8.05
    })
    timeLog.length = 0
    step()

    // 帧 2：跨过扩展 loopEnd(8.5)。清掉本帧的 drive 写入，只看引擎自己的 seek。
    act(() => {
      video.currentTime = 8.55
    })
    timeLog.length = 0
    step()
    const firedOnRisingEdge = timeLog.some((x) => Math.abs(x - 3.5) < 1e-3)

    // 继续推进，确认新逻辑稳定循环当前小节（不会误锁下一节）。
    let sawCurrent = firedOnRisingEdge
    let sawNext = false
    drive(video, timeLog, 8.55, 1500, 0.01, (x) => {
      if (Math.abs(x - 3.5) < 1e-3) sawCurrent = true
      if (Math.abs(x - 7.5) < 1e-3) sawNext = true
    })
    expect(sawCurrent).toBe(true)
    expect(sawNext).toBe(false)
    root.unmount()
    container.remove()
  })

  it('关闭后再打开循环 → 重新锁定「当前所在小节」（rising edge 二次触发）', () => {
    // 模拟用户在 segment 2 中段启用循环、随后关闭、再在 segment 3 中段重新启用：
    // 重新启用时应再次锁定「重新启用时所在的小节」(segment 3, loopStart=7.5)，
    // 而不是沿用旧的 segment 2 目标 (loopStart=3.5)。
    const segs = makeSegments()
    const { videoRef, video, timeLog, root, container } = setup({
      segments: segs,
      loop: true,
      offset: 0,
      beatDuration: 0.5,
    })
    // 第一次启用：停在 segment 2 中段 (t=6.0)
    act(() => {
      video.currentTime = 6.0
      video.dispatchEvent(new Event('seeked'))
    })
    step()

    // 关闭循环（else 分支会把 loopTarget 清 null、wasLoop 同步为 false）
    act(() => {
      root.render(<Harness videoRef={videoRef} segments={segs} loop={false} offset={0} beatDuration={0.5} />)
    })
    step()

    // 跳到 segment 3 中段 (t=10.0) 并重新启用循环
    act(() => {
      video.currentTime = 10.0
      video.dispatchEvent(new Event('seeked'))
      root.render(<Harness videoRef={videoRef} segments={segs} loop={true} offset={0} beatDuration={0.5} />)
    })
    step()

    let sawSeg2 = false
    let sawSeg3 = false
    drive(video, timeLog, 10.0, 3000, 0.01, (x) => {
      // segment 2 的 padded loopStart = 3.5；segment 3 的 padded loopStart = 7.5
      if (Math.abs(x - 3.5) < 1e-3) sawSeg2 = true
      if (Math.abs(x - 7.5) < 1e-3) sawSeg3 = true
    })
    // 重新启用时应循环 segment 3，而不是沿用旧的 segment 2 目标。
    expect(sawSeg3).toBe(true)
    expect(sawSeg2).toBe(false)
    root.unmount()
    container.remove()
  })
})
