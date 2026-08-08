// 试用示例模式的数据源。
//
// 在没有后端（静态部署，如 CloudStudio）时，用户点「试用示例」即可进入播放页，
// 看到一份内置的拍点网格 + 一段外网可直连的示例视频，从而离线测试所有 UI 交互
// （偏移、双镜像、点击循环等）。本模块只构造一份 AnalysisResult，不依赖任何后端。
//
// 设计要点：
//   - 6 个 segment，每个 8 拍，BPM = 100 => 每拍 0.6s，每节 4.8s。
//   - 每个 segment 的 `beats` 为该节 8 个拍的【绝对时间戳（秒）】，第 k 拍 =
//     startTime + (k-1) * 0.6（k=1..8）。
//   - 第 i 节 startTime = (i-1) * 4.8，endTime = i * 4.8。
//   - duration ≈ 28.8s（= 6 * 4.8），与示例视频时长（30s）兼容。

import type { AnalysisResult, Segment } from '../types/api'

/** 外网可直连的 30s 示例视频（Big Buck Bunny），用于 demo 离线播放测试。 */
export const DEMO_VIDEO_URL =
  'https://test-videos.co.uk/vids/bigbuckbunny/mp4/h264/360/Big_Buck_Bunny_360_30s_2MB.mp4'

const DEMO_BPM = 100
const DEMO_CONFIDENCE = 0.95
const DEMO_SEGMENT_COUNT = 6
const DEMO_BEATS_PER_SEGMENT = 8

/**
 * 构造一份示例分析结果，供「试用示例」模式使用。
 *
 * 每次调用都会基于当前时间生成 `createdAt`，其余字段为确定的内置拍点网格，
 * 保证 demo 会话内拍点稳定、可复现地测试所有 UI 交互。
 *
 * @returns 一个符合后端 `AnalysisResult` 结构的完整示例结果。
 */
export function buildDemoResult(): AnalysisResult {
  const beatDuration = 60 / DEMO_BPM // 0.6s / 拍
  const segmentDuration = beatDuration * DEMO_BEATS_PER_SEGMENT // 4.8s / 节
  const totalDuration = segmentDuration * DEMO_SEGMENT_COUNT // 28.8s

  const segments: Segment[] = []
  for (let i = 1; i <= DEMO_SEGMENT_COUNT; i++) {
    const startTime = (i - 1) * segmentDuration
    const endTime = i * segmentDuration
    const beats: number[] = []
    for (let k = 1; k <= DEMO_BEATS_PER_SEGMENT; k++) {
      // 第 k 拍的绝对时间戳：从本节起点依次累加 0.6s。
      beats.push(Number((startTime + (k - 1) * beatDuration).toFixed(3)))
    }
    segments.push({
      index: i,
      startTime: Number(startTime.toFixed(3)),
      endTime: Number(endTime.toFixed(3)),
      type: 'dance',
      beats,
    })
  }

  return {
    taskId: 'demo',
    videoName: '示例舞蹈（Demo）',
    bpm: DEMO_BPM,
    confidence: DEMO_CONFIDENCE,
    duration: Number(totalDuration.toFixed(3)),
    createdAt: new Date().toISOString(),
    segments,
  }
}
