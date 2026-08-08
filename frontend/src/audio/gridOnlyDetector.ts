import { ANALYSIS_SR, BPM_MAX, BPM_MIN } from './constants'
import type { DecodedAudio, DetectResult } from '../types/local'

// Internal detection hop (samples). Larger than HOP_TRACK to keep the ACF
// affordable on the worker thread for multi-minute clips.
const DETECT_HOP = 1024

/**
 * MVP auto-detector: estimate tempo via autocorrelation of an onset-flux
 * envelope, then lay a uniform beat grid from the strongest onset. No wasm,
 * no OLA — a zero-dependency fallback used only when the precise
 * `beat-detection` tracker (T03) returns no usable result. It is less
 * accurate than the precise path but always produces a usable beat grid.
 */
export function gridOnlyDetect(audio: DecodedAudio): DetectResult {
  const { pcm, sampleRate } = audio
  const sr = sampleRate || ANALYSIS_SR
  const nHops = Math.max(1, Math.floor(pcm.length / DETECT_HOP))

  // 1) Energy envelope per hop.
  const env = new Float32Array(nHops)
  for (let i = 0; i < nHops; i++) {
    const start = i * DETECT_HOP
    let sum = 0
    for (let j = 0; j < DETECT_HOP; j++) {
      const v = pcm[start + j] || 0
      sum += v * v
    }
    env[i] = Math.sqrt(sum / DETECT_HOP)
  }

  // 2) Positive spectral flux (onset strength).
  const flux = new Float32Array(nHops)
  for (let i = 1; i < nHops; i++) {
    const d = env[i] - env[i - 1]
    flux[i] = d > 0 ? d : 0
  }

  // 3) Restrict ACF lag search to a musically sane tempo band to bound cost.
  const minLag = Math.floor((sr * 60) / 200) // 200 BPM ceiling
  const maxLag = Math.floor((sr * 60) / Math.max(50, BPM_MIN)) // ~50 BPM floor
  let bestLag = minLag
  let bestScore = -Infinity
  for (let lag = minLag; lag <= maxLag; lag++) {
    let s = 0
    for (let i = 0; i + lag < nHops; i++) s += flux[i] * flux[i + lag]
    if (s > bestScore) {
      bestScore = s
      bestLag = lag
    }
  }

  let bpm = 60 / (bestLag / sr)
  // Fold into [BPM_MIN, BPM_MAX] by octave adjustment.
  while (bpm > BPM_MAX) bpm /= 2
  while (bpm < BPM_MIN) bpm *= 2

  // 4) First beat = time of the strongest onset in the opening bar.
  let firstBeatIdx = 1
  let firstBeatVal = -Infinity
  const searchEnd = Math.min(nHops, maxLag + 1)
  for (let i = 1; i < searchEnd; i++) {
    if (flux[i] > firstBeatVal) {
      firstBeatVal = flux[i]
      firstBeatIdx = i
    }
  }
  const firstBeat = (firstBeatIdx * DETECT_HOP) / sr
  const beatDur = 60 / bpm

  const duration = audio.duration
  const beatTimes: number[] = []
  for (let k = 0; ; k++) {
    const t = firstBeat + k * beatDur
    if (t > duration) break
    beatTimes.push(Number(t.toFixed(4)))
  }

  return {
    bpm,
    confidence: 0.7,
    beatTimes,
    duration,
    usedGrid: true,
    engine: 'grid-only',
  }
}
