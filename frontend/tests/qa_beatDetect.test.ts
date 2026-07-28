// QA-independent tests for essentia.js beat detection.
// Authored by QA (Edward) — verifies detectBeats calls RhythmExtractor2013 with
// the right argument shape (arrayToVector(sample) then (vector, sampleRate)),
// reads the defensive output fields (beats/ticks, bpm, confidence), and honors
// the abort signal. No real WASM: a fake essentia implements the tiny surface.
import { describe, it, expect, vi } from 'vitest'
import { detectBeats } from '../src/audio/beatDetect'
import type { AudioData } from '../src/types/audio'

function makeAudio(): AudioData {
  return { samples: new Float32Array(44100 * 2), sampleRate: 44100, duration: 2 }
}

function makeFakeEssentia(out: Record<string, unknown>) {
  const calls: { vec: unknown; sr: number }[] = []
  const essentia = {
    _calls: calls,
    arrayToVector: (s: Float32Array) => ({ _s: s }),
    RhythmExtractor2013: (vec: unknown, sr: number) => {
      calls.push({ vec, sr })
      return out
    },
    deleteVector: vi.fn(),
  }
  return essentia
}

describe('QA: detectBeats RhythmExtractor2013 conformance', () => {
  it('calls RhythmExtractor2013(vector, sampleRate) and maps beats/bpm/confidence', async () => {
    const essentia = makeFakeEssentia({
      beats: [0, 0.5, 1.0, 1.5],
      bpm: 120,
      confidence: 0.92,
    })
    const res = await detectBeats(essentia as any, makeAudio())
    expect(res.bpm).toBe(120)
    expect(res.beats).toEqual([0, 0.5, 1.0, 1.5])
    expect(res.confidence).toBe(0.92)
    expect(essentia._calls[0].sr).toBe(44100)
    // The passed vector must carry the original samples.
    expect((essentia._calls[0].vec as { _s: Float32Array })._s.length).toBe(44100 * 2)
  })

  it('falls back to `ticks` when `beats` is absent', async () => {
    const essentia = makeFakeEssentia({ ticks: [0.25, 0.75], bpm: 100, confidence: 0.8 })
    const res = await detectBeats(essentia as any, makeAudio())
    expect(res.beats).toEqual([0.25, 0.75])
    expect(res.bpm).toBe(100)
  })

  it('defaults confidence to 1.0 when missing or non-finite', async () => {
    const missing = makeFakeEssentia({ beats: [0], bpm: 90 })
    expect((await detectBeats(missing as any, makeAudio())).confidence).toBe(1.0)

    const nan = makeFakeEssentia({ beats: [0], bpm: 90, confidence: NaN })
    expect((await detectBeats(nan as any, makeAudio())).confidence).toBe(1.0)
  })

  it('filters non-finite beat values', async () => {
    const essentia = makeFakeEssentia({ beats: [0, NaN, 1.0, Infinity], bpm: 110, confidence: 0.7 })
    const res = await detectBeats(essentia as any, makeAudio())
    expect(res.beats).toEqual([0, 1.0])
  })

  it('throws AbortError when the signal is already aborted', async () => {
    const essentia = makeFakeEssentia({ beats: [0], bpm: 120, confidence: 0.9 })
    const ac = new AbortController()
    ac.abort()
    await expect(
      detectBeats(essentia as any, makeAudio(), { signal: ac.signal }),
    ).rejects.toMatchObject({ name: 'AbortError' })
  })
})
