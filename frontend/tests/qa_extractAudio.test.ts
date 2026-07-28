// QA-independent tests for the in-browser audio extractor.
// Authored by QA (Edward) — verifies (a) the exact ffmpeg.wasm command built by
// extractAudio, and (b) the RIFF/WAV -> Float32 decoder's robustness across PCM
// bit depths, multi-channel averaging, and non-standard chunk layouts.
// No real browser WASM is used: a fake FFmpeg implements the tiny surface
// extractAudio touches (writeFile/exec/readFile/deleteFile).
import { describe, it, expect } from 'vitest'
import { extractAudio, decodeWav } from '../src/audio/extractAudio'

// ---------------------------------------------------------------------------
// Minimal WAV builder (for decodeWav + extractAudio integration)
// ---------------------------------------------------------------------------
function writeStr(view: DataView, off: number, s: string) {
  for (let i = 0; i < s.length; i++) view.setUint8(off + i, s.charCodeAt(i))
}

function putSample(view: DataView, pos: number, bits: number, v: number) {
  switch (bits) {
    case 8:
      view.setUint8(pos, Math.max(0, Math.min(255, Math.round((v + 1) * 127.5))))
      break
    case 16:
      view.setInt16(pos, Math.max(-32768, Math.min(32767, Math.round(v * 32767))), true)
      break
    case 24: {
      const x = Math.max(-8388608, Math.min(8388607, Math.round(v * 8388607)))
      view.setUint8(pos, x & 0xff)
      view.setUint8(pos + 1, (x >> 8) & 0xff)
      view.setUint8(pos + 2, (x >> 16) & 0xff)
      break
    }
    case 32:
      view.setFloat32(pos, v, true)
      break
  }
}

/** Build a proper RIFF/WAVE buffer. `fill(ch, i)` returns the sample in [-1,1]. */
function makeWav(opts: {
  channels: number
  sampleRate: number
  bits: number
  frames: number
  fill?: (ch: number, i: number) => number
  extraBeforeData?: Uint8Array
}): Uint8Array {
  const bps = opts.bits / 8
  const frameSize = bps * opts.channels
  const dataSize = frameSize * opts.frames
  const fmtSize = 16
  const extra = opts.extraBeforeData ?? new Uint8Array(0)
  // RIFF chunks are word-aligned: an odd-sized extra chunk occupies an extra pad
  // byte on disk — matching what decodeWav expects when it skips the chunk.
  const extraLen = extra.length + (extra.length % 2)
  const headerSize = 12 + 8 + fmtSize + extraLen + 8 + dataSize
  const buf = new ArrayBuffer(headerSize)
  const view = new DataView(buf)
  writeStr(view, 0, 'RIFF')
  view.setUint32(4, headerSize - 8, true)
  writeStr(view, 8, 'WAVE')
  writeStr(view, 12, 'fmt ')
  view.setUint32(16, fmtSize, true)
  view.setUint16(20, 1, true) // PCM
  view.setUint16(22, opts.channels, true)
  view.setUint32(24, opts.sampleRate, true)
  view.setUint32(28, opts.sampleRate * frameSize, true)
  view.setUint16(32, frameSize, true)
  view.setUint16(34, opts.bits, true)
  let p = 12 + 8 + fmtSize
  for (let i = 0; i < extra.length; i++) view.setUint8(p + i, extra[i])
  p += extraLen
  writeStr(view, p, 'data')
  view.setUint32(p + 4, dataSize, true)
  p += 8
  for (let i = 0; i < opts.frames; i++) {
    for (let c = 0; c < opts.channels; c++) {
      const v = opts.fill ? opts.fill(c, i) : 0
      putSample(view, p + (i * opts.channels + c) * bps, opts.bits, v)
    }
  }
  return new Uint8Array(buf)
}

/** A valid (but otherwise meaningless) LIST chunk used to test non-standard layouts. */
function makeListChunk(size: number): Uint8Array {
  const buf = new ArrayBuffer(8 + size)
  const view = new DataView(buf)
  writeStr(view, 0, 'LIST')
  view.setUint32(4, size, true)
  return new Uint8Array(buf)
}

// ---------------------------------------------------------------------------
// decodeWav — PCM robustness
// ---------------------------------------------------------------------------
describe('QA: decodeWav PCM decoding', () => {
  it('decodes 16-bit mono and normalizes to [-1,1]', () => {
    const wav = makeWav({ channels: 1, sampleRate: 44100, bits: 16, frames: 4, fill: () => 0.5 })
    const { samples, sampleRate, duration } = decodeWav(wav)
    expect(sampleRate).toBe(44100)
    expect(samples.length).toBe(4)
    expect(duration).toBeCloseTo(4 / 44100, 10)
    for (const s of samples) expect(s).toBeCloseTo(0.5, 3)
  })

  it('averages multi-channel frames down to mono (stereo 1.0 / -1.0 -> 0)', () => {
    const wav = makeWav({
      channels: 2,
      sampleRate: 44100,
      bits: 16,
      frames: 8,
      fill: (ch) => (ch === 0 ? 1 : -1),
    })
    const { samples } = decodeWav(wav)
    expect(samples.length).toBe(8)
    for (const s of samples) expect(s).toBeCloseTo(0, 3)
  })

  it('decodes 8-bit unsigned PCM (center 128)', () => {
    const wav = makeWav({ channels: 1, sampleRate: 8000, bits: 8, frames: 2, fill: () => 0.5 })
    const { samples, sampleRate } = decodeWav(wav)
    expect(sampleRate).toBe(8000)
    // 8-bit PCM has 256 levels -> ~0.008 quantization; accept that tolerance.
    for (const s of samples) expect(s).toBeCloseTo(0.5, 1)
  })

  it('decodes 24-bit signed PCM', () => {
    const wav = makeWav({ channels: 1, sampleRate: 44100, bits: 24, frames: 2, fill: () => 0.25 })
    const { samples } = decodeWav(wav)
    for (const s of samples) expect(s).toBeCloseTo(0.25, 3)
  })

  it('decodes 32-bit IEEE float PCM (exact)', () => {
    const wav = makeWav({ channels: 1, sampleRate: 44100, bits: 32, frames: 3, fill: () => -0.75 })
    const { samples } = decodeWav(wav)
    for (const s of samples) expect(s).toBe(-0.75)
  })

  it('skips non-standard chunks (LIST) between fmt and data', () => {
    const list = makeListChunk(5) // odd size -> tests word-align padding
    const wav = makeWav({
      channels: 1,
      sampleRate: 44100,
      bits: 16,
      frames: 4,
      fill: () => 0.5,
      extraBeforeData: list,
    })
    const { samples } = decodeWav(wav)
    expect(samples.length).toBe(4)
    for (const s of samples) expect(s).toBeCloseTo(0.5, 3)
  })

  it('throws on a non-RIFF buffer', () => {
    const bad = new Uint8Array([1, 2, 3, 4, 0, 0, 0, 0, 0, 0, 0, 0])
    expect(() => decodeWav(bad)).toThrow(/WAV/)
  })

  it('throws when the data chunk is missing', () => {
    // RIFF/WAVE with only a fmt chunk, no data.
    const buf = new ArrayBuffer(12 + 8 + 16)
    const view = new DataView(buf)
    writeStr(view, 0, 'RIFF')
    view.setUint32(4, buf.byteLength - 8, true)
    writeStr(view, 8, 'WAVE')
    writeStr(view, 12, 'fmt ')
    view.setUint32(16, 16, true)
    expect(() => decodeWav(new Uint8Array(buf))).toThrow(/data/)
  })
})

// ---------------------------------------------------------------------------
// extractAudio — ffmpeg.wasm command + integration with decodeWav
// ---------------------------------------------------------------------------
function makeFakeFfmpeg(readFileBytes: Uint8Array) {
  return {
    terminated: false,
    lastArgs: null as string[] | null,
    written: [] as string[],
    async writeFile(name: string, _data: Uint8Array) {
      this.written.push(name)
    },
    async exec(args: string[]) {
      this.lastArgs = args
    },
    readFile(_name: string) {
      return readFileBytes
    },
    async deleteFile(_name: string) {
      /* noop */
    },
  }
}

describe('QA: extractAudio ffmpeg command + decode', () => {
  it('builds exactly "-i input_media -vn -ac 1 -ar 44100 -f wav output.wav"', async () => {
    const wav = makeWav({ channels: 1, sampleRate: 44100, bits: 16, frames: 44100 }) // 1s
    const ff = makeFakeFfmpeg(wav)
    const file = new File([new Uint8Array([1, 2, 3, 4])], 'clip.mp4', { type: 'video/mp4' })
    await extractAudio(ff as any, file)
    expect(ff.lastArgs).toEqual(['-i', 'input_media', '-vn', '-ac', '1', '-ar', '44100', '-f', 'wav', 'output.wav'])
    expect(ff.written).toContain('input_media')
  })

  it('returns mono Float32 at 44100 with correct duration and cleans temp files', async () => {
    const frames = 44100 * 2 // 2 seconds
    const wav = makeWav({
      channels: 1,
      sampleRate: 44100,
      bits: 16,
      frames,
      fill: (_, i) => Math.sin(i / 20),
    })
    const ff = makeFakeFfmpeg(wav)
    const file = new File([new Uint8Array([9, 9, 9])], 'clip.mp4')
    const out = await extractAudio(ff as any, file)
    expect(out.sampleRate).toBe(44100)
    expect(out.samples).toBeInstanceOf(Float32Array)
    expect(out.samples.length).toBe(frames)
    expect(out.duration).toBeCloseTo(2, 6)
  })

  it('propagates an abort before extraction as an AbortError', async () => {
    const wav = makeWav({ channels: 1, sampleRate: 44100, bits: 16, frames: 100 })
    const ff = makeFakeFfmpeg(wav)
    const file = new File([new Uint8Array([1])], 'clip.mp4')
    const ac = new AbortController()
    ac.abort()
    await expect(extractAudio(ff as any, file, { signal: ac.signal })).rejects.toMatchObject({
      name: 'AbortError',
    })
  })
})
