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
  const countGain = {
    gain: {
      value: 1,
      setValueAtTime: vi.fn(),
      exponentialRampToValueAtTime: vi.fn(),
    },
    connect: vi.fn(),
    disconnect: vi.fn(),
  }
  const oscillator = {
    type: 'sine' as OscillatorType,
    frequency: {
      setValueAtTime: vi.fn(),
      exponentialRampToValueAtTime: vi.fn(),
    },
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
    currentTime: 10,
    destination: output,
    resume: vi.fn().mockResolvedValue(undefined),
    createMediaStreamDestination: vi.fn(() => mixedDestination),
    createBufferSource: vi.fn(() => countSource),
    createGain: vi.fn(() => countGain),
    createOscillator: vi.fn(() => oscillator),
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

  it('applies one count volume to both the learner and recording destination', async () => {
    const { playCountVoice } = await import('../src/audio/countVoiceAudio')
    await playCountVoice(3, 1.75)

    expect(globalThis.fetch).toHaveBeenCalledWith('/voice-counts/3.wav')
    expect(context.createGain).toHaveBeenCalled()
    expect(countGain.gain.value).toBe(1.75)
    expect(countSource.connect).toHaveBeenCalledWith(countGain)
    expect(countGain.connect).toHaveBeenCalledWith(output)
    expect(countGain.connect).toHaveBeenCalledWith(mixedDestination)
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

  it('synthesizes an accented metronome sound into speakers and recording mix', async () => {
    const { playMetronomeBeat } = await import('../src/audio/countVoiceAudio')
    await playMetronomeBeat(1, 'wood', 1.5)

    expect(context.createOscillator).toHaveBeenCalled()
    expect(oscillator.type).toBe('triangle')
    expect(oscillator.frequency.setValueAtTime).toHaveBeenCalledWith(900, 10)
    expect(oscillator.connect).toHaveBeenCalledWith(countGain)
    expect(countGain.connect).toHaveBeenCalledWith(output)
    expect(countGain.connect).toHaveBeenCalledWith(mixedDestination)
    expect(oscillator.start).toHaveBeenCalledWith(10)
    expect(oscillator.stop).toHaveBeenCalledWith(10.08)
  })

  it('keeps a double-time midpoint unaccented even after dance count 8', async () => {
    const { playMetronomeBeat } = await import('../src/audio/countVoiceAudio')
    await playMetronomeBeat(1, 'click', 1, false)

    expect(oscillator.frequency.setValueAtTime).toHaveBeenCalledWith(1200, 10)
  })
})
