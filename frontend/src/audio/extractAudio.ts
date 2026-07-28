import type { FFmpeg } from '@ffmpeg/ffmpeg'
import type { AudioData } from '../types/audio'

const INPUT_NAME = 'input_media'
const OUTPUT_NAME = 'output.wav'

export interface ExtractOptions {
  /** Abort signal — checked between the write / exec / read stages. */
  signal?: AbortSignal
  /** Reserved for future per-stage progress callbacks. */
  onProgress?: (ratio: number) => void
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    const err = new Error('音频提取已取消')
    err.name = 'AbortError'
    throw err
  }
}

/**
 * Extract a single-channel, 44.1 kHz WAV from a video `File` using ffmpeg.wasm,
 * then decode the WAV container into a Float32Array of mono samples.
 *
 * Steps:
 *   1. write the video bytes into the ffmpeg in-memory FS
 *   2. `ffmpeg -i input -vn -ac 1 -ar 44100 -f wav output.wav`
 *   3. read `output.wav` and parse the RIFF/PCM header into Float32 [-1, 1]
 *   4. delete the temp files to free the FS
 *
 * The extractor forces `-ac 1 -ar 44100` so the downstream essentia analysis
 * always receives a normalized mono signal at a fixed sample rate, which keeps
 * memory and CPU bounded for longer videos.
 */
export async function extractAudio(
  ffmpeg: FFmpeg,
  file: File,
  opts: ExtractOptions = {},
): Promise<AudioData> {
  throwIfAborted(opts.signal)

  const inputBytes = new Uint8Array(await file.arrayBuffer())
  await ffmpeg.writeFile(INPUT_NAME, inputBytes)

  try {
    throwIfAborted(opts.signal)
    await ffmpeg.exec([
      '-i',
      INPUT_NAME,
      '-vn', // drop video stream
      '-ac',
      '1', // mono
      '-ar',
      '44100', // 44.1 kHz
      '-f',
      'wav',
      OUTPUT_NAME,
    ])
    throwIfAborted(opts.signal)

    const data = await ffmpeg.readFile(OUTPUT_NAME)
    const bytes =
      data instanceof Uint8Array ? data : new TextEncoder().encode(data)
    const { samples, sampleRate } = decodeWav(bytes)
    const duration = sampleRate > 0 ? samples.length / sampleRate : 0
    return { samples, sampleRate, duration }
  } finally {
    try {
      await ffmpeg.deleteFile(INPUT_NAME)
    } catch {
      /* best effort */
    }
    try {
      await ffmpeg.deleteFile(OUTPUT_NAME)
    } catch {
      /* best effort */
    }
  }
}

interface WavMeta {
  sampleRate: number
  bitsPerSample: number
  channels: number
}

/**
 * Parse a RIFF/WAVE byte buffer and return mono Float32 samples in [-1, 1].
 *
 * Supports PCM 8/16/24/32-bit and 32-bit IEEE float, averaging multi-channel
 * frames down to mono. ffmpeg's `-f wav` default is 16-bit PCM, but we stay
 * defensive so a different encoder output does not crash the pipeline.
 */
export function decodeWav(bytes: Uint8Array): AudioData {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  if (
    String.fromCharCode(view.getUint8(0), view.getUint8(1), view.getUint8(2), view.getUint8(3)) !==
    'RIFF'
  ) {
    throw new Error('提取出的音频不是有效的 WAV 文件')
  }

  const meta: WavMeta = { sampleRate: 44100, bitsPerSample: 16, channels: 1 }
  let dataOffset = -1
  let dataLength = 0

  let offset = 12
  while (offset + 8 <= view.byteLength) {
    const id = String.fromCharCode(
      view.getUint8(offset),
      view.getUint8(offset + 1),
      view.getUint8(offset + 2),
      view.getUint8(offset + 3),
    )
    const size = view.getUint32(offset + 4, true)
    if (id === 'fmt ') {
      meta.channels = view.getUint16(offset + 10, true) || 1
      meta.sampleRate = view.getUint32(offset + 12, true) || 44100
      meta.bitsPerSample = view.getUint16(offset + 22, true) || 16
    } else if (id === 'data') {
      dataOffset = offset + 8
      dataLength = size
      break
    }
    // Chunks are word-aligned (padded to an even byte count).
    offset += 8 + size + (size % 2)
  }

  if (dataOffset < 0) throw new Error('WAV 缺少 data 块')

  const bytesPerSample = meta.bitsPerSample / 8
  const frameSize = bytesPerSample * meta.channels
  if (frameSize <= 0) throw new Error('WAV 采样格式无法解析')
  const monoCount = Math.floor(dataLength / frameSize)
  const samples = new Float32Array(monoCount)

  for (let i = 0; i < monoCount; i++) {
    let sum = 0
    for (let c = 0; c < meta.channels; c++) {
      const pos = dataOffset + (i * meta.channels + c) * bytesPerSample
      sum += readSample(view, pos, meta.bitsPerSample)
    }
    samples[i] = sum / meta.channels
  }

  const sampleRate = meta.sampleRate
  const duration = sampleRate > 0 ? samples.length / sampleRate : 0
  return { samples, sampleRate, duration }
}

/** Read one PCM sample at `pos` and normalize it to [-1, 1]. */
function readSample(view: DataView, pos: number, bits: number): number {
  switch (bits) {
    case 8:
      // 8-bit PCM is unsigned, centered at 128.
      return (view.getUint8(pos) - 128) / 128
    case 16:
      return view.getInt16(pos, true) / 32768
    case 24: {
      const b0 = view.getUint8(pos)
      const b1 = view.getUint8(pos + 1)
      const b2 = view.getUint8(pos + 2)
      let v = (b2 << 16) | (b1 << 8) | b0
      if (v & 0x800000) v -= 0x1000000 // sign-extend 24-bit
      return v / 8388608
    }
    case 32: {
      // Prefer IEEE float; fall back to signed int32 if the float is NaN/Inf
      // (which indicates integer PCM rather than float).
      const f = view.getFloat32(pos, true)
      if (Number.isFinite(f)) return f
      return view.getInt32(pos, true) / 2147483648
    }
    default:
      return 0
  }
}
