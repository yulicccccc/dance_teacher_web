import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

describe('shared count-command audio bus', () => {
  const output = { name: 'speakers' }
  const mixedTrack = { kind: 'audio', id: 'count-mix' } as MediaStreamTrack
  const mixedDestination = {
    stream: { getAudioTracks: () => [mixedTrack] },
  }
  const countSource = {
    buffer: null as AudioBuffer | null,
    connect: vi.fn(),
    disconnect: vi.fn(),
    start: vi.fn(),
    stop: vi.fn(),
  }
  const teacherSource = {
    connect: vi.fn(),
    disconnect: vi.fn(),
  }
  const context = {
    state: 'running',
    destination: output,
    resume: vi.fn().mockResolvedValue(undefined),
    createMediaStreamDestination: vi.fn(() => mixedDestination),
    createBufferSource: vi.fn(() => countSource),
    createMediaStreamSource: vi.fn(() => teacherSource),
    decodeAudioData: vi.fn().mockResolvedValue({ duration: 0.4 } as AudioBuffer),
    close: vi.fn().mockResolvedValue(undefined),
  }
  const AudioContextMock = vi.fn(() => context)
  const originalAudioContext = window.AudioContext
  const originalFetch = globalThis.fetch

  beforeEach(() => {
    vi.resetModules()
    vi.clearAllMocks()
    Object.defineProperty(window, 'AudioContext', {
      configurable: true,
      value: AudioContextMock,
    })
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      arrayBuffer: () => Promise.resolve(new ArrayBuffer(16)),
    }) as typeof fetch
  })

  afterEach(() => {
    Object.defineProperty(window, 'AudioContext', {
      configurable: true,
      value: originalAudioContext,
    })
    globalThis.fetch = originalFetch
  })

  it('plays each number to the learner and the recording destination', async () => {
    const { playCountVoice } = await import('../src/audio/countVoiceAudio')
    await playCountVoice(3)

    expect(globalThis.fetch).toHaveBeenCalledWith('/voice-counts/3.wav')
    expect(countSource.connect).toHaveBeenCalledWith(output)
    expect(countSource.connect).toHaveBeenCalledWith(mixedDestination)
    expect(countSource.start).toHaveBeenCalled()
  })

  it('mixes teacher audio into the same single track that carries count commands', async () => {
    const { prepareComparisonAudio } = await import('../src/audio/countVoiceAudio')
    const teacherTrack = { kind: 'audio', id: 'teacher' } as MediaStreamTrack
    const teacherStream = {
      getAudioTracks: () => [teacherTrack],
    } as MediaStream
    const teacherVideo = {
      captureStream: () => teacherStream,
    } as unknown as HTMLVideoElement

    const mix = await prepareComparisonAudio(teacherVideo)
    expect(mix?.track).toBe(mixedTrack)
    expect(context.createMediaStreamSource).toHaveBeenCalledWith(teacherStream)
    expect(teacherSource.connect).toHaveBeenCalledWith(mixedDestination)
    mix?.cleanup()
    expect(teacherSource.disconnect).toHaveBeenCalled()
  })
})
