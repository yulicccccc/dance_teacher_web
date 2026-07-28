// QA-independent tests for AnalyzePipeline (orchestration + state machine).
// Authored by QA (Edward) — exercises load -> extract -> detect -> segment with
// injected fake ffmpeg/essentia (no real WASM). Verifies:
//   * phase transitions (loading_engine -> extracting -> detecting -> segmenting)
//   * beatLowConfidence flag
//   * cancel() yields an AnalysisError with code CANCELLED
//   * [BUG REPRO] cancel() terminates the cached ffmpeg SINGLETON, so a
//     subsequent run reuses the dead instance and fails. The mock's
//     resetLoaders() recreates a fresh instance, so this test passes ONLY once
//     AnalyzePipeline.cancel() calls resetLoaders() after terminating.
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { AnalyzePipeline } from '../src/analysis/analyzePipeline'
import type { FFmpeg } from '@ffmpeg/ffmpeg'

// ---- fakes (function declarations are hoisted; safe to use in vi.hoisted) ----
function makeWav8s(): Uint8Array {
  const sampleRate = 8000
  const frames = sampleRate * 8 // 8 seconds
  const bps = 2
  const dataSize = frames * bps
  const buf = new ArrayBuffer(44 + dataSize)
  const view = new DataView(buf)
  const ws = (off: number, s: string) => {
    for (let i = 0; i < s.length; i++) view.setUint8(off + i, s.charCodeAt(i))
  }
  ws(0, 'RIFF')
  view.setUint32(4, buf.byteLength - 8, true)
  ws(8, 'WAVE')
  ws(12, 'fmt ')
  view.setUint32(16, 16, true)
  view.setUint16(20, 1, true)
  view.setUint16(22, 1, true)
  view.setUint32(24, sampleRate, true)
  view.setUint32(28, sampleRate * bps, true)
  view.setUint16(32, bps, true)
  view.setUint16(34, 16, true)
  ws(36, 'data')
  view.setUint32(40, dataSize, true)
  // leave samples as zeros
  return new Uint8Array(buf)
}

function makeFakeFfmpeg() {
  return {
    terminated: false,
    mode: 'resolve' as 'resolve' | 'hang',
    lastArgs: null as string[] | null,
    _execReject: null as null | ((e: Error) => void),
    async writeFile(_name: string, _data: Uint8Array) {
      if (this.terminated) throw new Error('ffmpeg terminated')
    },
    exec(args: string[]) {
      this.lastArgs = args
      if (this.terminated) return Promise.reject(Object.assign(new Error('ffmpeg terminated'), { name: 'AbortError' }))
      if (this.mode === 'hang') {
        return new Promise<number>((_resolve, reject) => {
          this._execReject = reject
        })
      }
      return Promise.resolve(0)
    },
    readFile(_name: string) {
      if (this.terminated) throw new Error('ffmpeg terminated')
      return makeWav8s()
    },
    async deleteFile(_name: string) {
      /* noop */
    },
    terminate() {
      this.terminated = true
      if (this._execReject) {
        const r = this._execReject
        this._execReject = null
        r(Object.assign(new Error('terminated'), { name: 'AbortError' }))
      }
    },
  }
}

function makeFakeEssentia(confidence: number) {
  return {
    arrayToVector: (s: Float32Array) => ({ _s: s }),
    RhythmExtractor2013: (_vec: unknown, _sr: number) => ({
      beats: Array.from({ length: 16 }, (_, i) => i * 0.5),
      bpm: 120,
      confidence,
    }),
    deleteVector: () => {},
  }
}

const h = vi.hoisted(() => ({
  currentFfmpeg: makeFakeFfmpeg(),
  essentia: makeFakeEssentia(0.9),
  detectBeats: Array.from({ length: 16 }, (_, i) => i * 0.5),
}))

vi.mock('../src/wasm/loaders', () => ({
  loadFfmpeg: vi.fn(async () => h.currentFfmpeg),
  loadEssentia: vi.fn(async () => h.essentia),
  // A correct implementation recreates the engine after terminate(); the mock
  // models that so the [BUG REPRO] test below passes only once the source does.
  resetLoaders: vi.fn(() => {
    h.currentFfmpeg = makeFakeFfmpeg()
  }),
  isMultithread: () => false,
  ffmpegUsesMultithread: () => false,
}))

const file = new File([new Uint8Array([1, 2, 3])], 'clip.mp4', { type: 'video/mp4' })

beforeEach(() => {
  h.currentFfmpeg = makeFakeFfmpeg()
  h.essentia = makeFakeEssentia(0.9)
  vi.clearAllMocks()
})

describe('QA: AnalyzePipeline happy path + state machine', () => {
  it('emits the full phase sequence and produces a 2-phrase result at 120 BPM', async () => {
    const phases: string[] = []
    const p = new AnalyzePipeline()
    const { result } = await p.run(file, {
      videoId: 'a',
      videoName: 'a.mp4',
      callbacks: { onPhase: (ph) => phases.push(ph) },
    })
    expect(phases).toContain('loading_engine')
    expect(phases).toContain('extracting')
    expect(phases).toContain('detecting')
    expect(phases).toContain('segmenting')
    expect(result.bpm).toBe(120)
    expect(result.segments.length).toBe(2) // 16 beats -> 2 x 8-beat phrases
    expect(result.duration).toBeCloseTo(8, 6)
    expect(result.beatLowConfidence).toBe(false) // 0.9 >= 0.6
  })

  it('flags beatLowConfidence when confidence < 0.6', async () => {
    h.essentia = makeFakeEssentia(0.3)
    const p = new AnalyzePipeline()
    const { result } = await p.run(file, { videoId: 'low', videoName: 'low.mp4' })
    expect(result.confidence).toBe(0.3)
    expect(result.beatLowConfidence).toBe(true)
  })
})

describe('QA: AnalyzePipeline cancel', () => {
  it('cancel() aborts in-flight extraction and rejects with code CANCELLED', async () => {
    h.currentFfmpeg.mode = 'hang'
    const usedFfmpeg = h.currentFfmpeg // capture the instance this run will use
    const p = new AnalyzePipeline()
    const runPromise = p.run(file, { videoId: 'b', videoName: 'b.mp4' })
    await new Promise((r) => setTimeout(r, 20)) // let it reach ffmpeg.exec (hangs)
    p.cancel()
    await expect(runPromise).rejects.toMatchObject({ code: 'CANCELLED' })
    // The cancelled instance must have been terminated. NOTE: cancel() now also
    // calls resetLoaders() (the PR fix), which recreates the module-singleton,
    // so we assert on the captured instance rather than the shared h.currentFfmpeg.
    expect(usedFfmpeg.terminated).toBe(true)
  })
})

describe('QA: AnalyzePipeline cancel-then-retry (singleton reuse)', () => {
  it('BUG REPRO: after cancel(), a fresh run must re-initialize the engine (currently fails)', async () => {
    // 1) Start and cancel -> terminates the cached ffmpeg singleton.
    h.currentFfmpeg.mode = 'hang'
    const pB = new AnalyzePipeline()
    const runB = pB.run(file, { videoId: 'b', videoName: 'b.mp4' })
    await new Promise((r) => setTimeout(r, 20))
    pB.cancel()
    await expect(runB).rejects.toMatchObject({ code: 'CANCELLED' })

    // 2) A follow-up analysis must succeed (the engine should be reloaded).
    //    With the CURRENT source, cancel() does NOT invalidate the singleton,
    //    so this run reuses the terminated instance and throws -> test fails.
    h.currentFfmpeg.mode = 'resolve'
    const pC = new AnalyzePipeline()
    const outcome = await pC.run(file, { videoId: 'c', videoName: 'c.mp4' })
    expect(outcome.result).toBeDefined()
    expect(outcome.result.segments.length).toBeGreaterThan(0)
  })
})
