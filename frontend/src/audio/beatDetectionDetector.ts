import { detect } from 'beat-detection'
import { ANALYSIS_SR, BPM_MAX, BPM_MIN } from './constants'
import type { DecodedAudio, DetectResult } from '../types/local'

/**
 * Precise in-browser beat detector (T03) built on `beat-detection`
 * (MIT, pure-JS): spectral-flux onset detection → autocorrelation +
 * comb-filter tempo → dynamic-programming beat tracking.
 *
 * It runs on the raw mono PCM **inside the Web Worker** — no wasm, no
 * backend — and is far more accurate than the MVP ACF grid
 * (`gridOnlyDetector`). The worker calls this first and only falls back to
 * the grid detector when this returns null (empty/undefined input) or throws.
 */
export function beatDetectionDetect(audio: DecodedAudio): DetectResult | null {
  const { pcm, sampleRate } = audio
  if (!pcm || pcm.length === 0) return null
  const sr = sampleRate || ANALYSIS_SR

  const { bpm, confidence, beats } = detect(pcm, {
    fs: sr,
    minBpm: BPM_MIN,
    maxBpm: BPM_MAX,
  })

  if (!Number.isFinite(bpm) || bpm <= 0 || !beats || beats.length === 0) {
    return null
  }

  const duration = audio.duration
  const beatTimes: number[] = []
  for (let i = 0; i < beats.length; i++) {
    const t = beats[i]
    // Keep only beats strictly inside the clip.
    if (t < 0 || t > duration) continue
    beatTimes.push(Number(t.toFixed(4)))
  }
  if (beatTimes.length === 0) return null

  return {
    bpm: Number(bpm.toFixed(2)),
    confidence: Number(confidence.toFixed(3)),
    beatTimes,
    duration,
    usedGrid: false,
    engine: 'beat-detection',
  }
}
