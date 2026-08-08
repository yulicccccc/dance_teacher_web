import { ANALYSIS_SR } from './constants'
import type { DecodedAudio } from '../types/local'

/**
 * Decode a video/audio File into mono PCM at the analysis sample rate using the
 * browser's native WebAudio decoder. No backend, no wasm — works fully offline.
 * The decoded `pcm` is cached by the caller (videoRegistry) for later recompute.
 */
export async function decodeAudioFile(file: File): Promise<DecodedAudio> {
  const arrayBuffer = await file.arrayBuffer()
  // An OfflineAudioContext whose sampleRate is our target rate makes the browser
  // resample the decoded audio to ANALYSIS_SR during decodeAudioData.
  const ctx = new OfflineAudioContext(1, 1, ANALYSIS_SR)
  const audioBuffer = await ctx.decodeAudioData(arrayBuffer)
  const channel = audioBuffer.getChannelData(0)
  const pcm = new Float32Array(channel.length)
  pcm.set(channel)
  return {
    pcm,
    sampleRate: audioBuffer.sampleRate,
    duration: audioBuffer.duration,
  }
}
