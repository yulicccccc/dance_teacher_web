const COUNT_CLIP_ROOT = '/voice-counts'

type AudioContextConstructor = new () => AudioContext
type CapturableVideo = HTMLVideoElement & {
  captureStream?: () => MediaStream
  mozCaptureStream?: () => MediaStream
}

export interface ComparisonAudioMix {
  track: MediaStreamTrack
  cleanup: () => void
}

export type MetronomeSound = 'click' | 'wood' | 'beep'

let context: AudioContext | null = null
let mixDestination: MediaStreamAudioDestinationNode | null = null
let activeSource: AudioBufferSourceNode | null = null
let activeMetronome: OscillatorNode | null = null
let playGeneration = 0
const buffers = new Map<number, Promise<AudioBuffer>>()

function getAudioContext(): AudioContext | null {
  if (context) return context
  const webkit = window as unknown as { webkitAudioContext?: AudioContextConstructor }
  const Constructor = window.AudioContext ?? webkit.webkitAudioContext
  if (!Constructor) return null
  context = new Constructor()
  return context
}

async function resume(contextToResume: AudioContext): Promise<void> {
  if (contextToResume.state === 'suspended') {
    await contextToResume.resume()
  }
}

function getMixDestination(
  contextForDestination: AudioContext,
): MediaStreamAudioDestinationNode {
  if (!mixDestination) {
    mixDestination = contextForDestination.createMediaStreamDestination()
  }
  return mixDestination
}

function loadCountBuffer(beat: number): Promise<AudioBuffer> {
  const cached = buffers.get(beat)
  if (cached) return cached
  const audioContext = getAudioContext()
  if (!audioContext) return Promise.reject(new Error('Web Audio unavailable'))
  const loading = fetch(`${COUNT_CLIP_ROOT}/${beat}.wav`)
    .then((response) => {
      if (!response.ok) throw new Error(`Count voice ${beat} is unavailable`)
      return response.arrayBuffer()
    })
    .then((data) => audioContext.decodeAudioData(data))
  buffers.set(beat, loading)
  return loading
}

/** Call directly from the 口令 button click so browser autoplay is unlocked. */
export async function unlockCountVoiceAudio(): Promise<void> {
  const audioContext = getAudioContext()
  if (!audioContext) return
  await resume(audioContext)
  void Promise.allSettled(
    Array.from({ length: 8 }, (_, index) => loadCountBuffer(index + 1)),
  )
}

/** Play one short count at the same volume in speakers and the recording mix. */
export async function playCountVoice(beat: number, volume = 1): Promise<void> {
  if (beat < 1 || beat > 8) return
  const generation = ++playGeneration
  const audioContext = getAudioContext()
  if (!audioContext) return
  try {
    await resume(audioContext)
    const buffer = await loadCountBuffer(beat)
    if (generation !== playGeneration) return
    try {
      activeSource?.stop()
    } catch {
      /* the previous short clip already ended */
    }
    const source = audioContext.createBufferSource()
    const gain = audioContext.createGain()
    gain.gain.value = Math.max(0, Math.min(2, volume))
    source.buffer = buffer
    source.connect(gain)
    gain.connect(audioContext.destination)
    gain.connect(getMixDestination(audioContext))
    activeSource = source
    source.start()
  } catch {
    // A missing optional sample must not interrupt playback or looping.
  }
}

export function stopCountVoice(): void {
  playGeneration += 1
  try {
    activeSource?.stop()
  } catch {
    /* already ended */
  }
  activeSource = null
}

const METRONOME_SOUNDS: Record<
  MetronomeSound,
  {
    type: OscillatorType
    regularFrequency: number
    accentFrequency: number
    duration: number
  }
> = {
  click: {
    type: 'square',
    regularFrequency: 1200,
    accentFrequency: 1800,
    duration: 0.035,
  },
  wood: {
    type: 'triangle',
    regularFrequency: 650,
    accentFrequency: 900,
    duration: 0.08,
  },
  beep: {
    type: 'sine',
    regularFrequency: 700,
    accentFrequency: 1050,
    duration: 0.12,
  },
}

/** Unlock Web Audio from a direct user gesture before the first metronome beat. */
export async function unlockMetronomeAudio(): Promise<void> {
  const audioContext = getAudioContext()
  if (!audioContext) return
  await resume(audioContext)
}

/**
 * Synthesize one short beat from the shared clock. Beat 1 is deliberately
 * higher and louder so phrase alignment is audible without looking at the UI.
 * The same gain feeds speakers and the comparison-recording mix.
 */
export async function playMetronomeBeat(
  beat: number,
  sound: MetronomeSound = 'click',
  volume = 0.8,
  accentOverride?: boolean,
): Promise<void> {
  if (beat < 1 || beat > 8) return
  const audioContext = getAudioContext()
  if (!audioContext) return
  await resume(audioContext)
  try {
    activeMetronome?.stop()
  } catch {
    /* the previous click already ended */
  }

  const spec = METRONOME_SOUNDS[sound]
  const accented = accentOverride ?? (beat === 1)
  const now = audioContext.currentTime
  const oscillator = audioContext.createOscillator()
  const gain = audioContext.createGain()
  const safeVolume = Math.max(0, Math.min(2, volume))
  const peak = Math.max(0.0001, safeVolume * (accented ? 0.9 : 0.55))
  const frequency = accented ? spec.accentFrequency : spec.regularFrequency

  oscillator.type = spec.type
  oscillator.frequency.setValueAtTime(frequency, now)
  if (sound === 'wood') {
    oscillator.frequency.exponentialRampToValueAtTime(
      frequency * 0.65,
      now + spec.duration,
    )
  }
  gain.gain.setValueAtTime(peak, now)
  gain.gain.exponentialRampToValueAtTime(0.0001, now + spec.duration)
  oscillator.connect(gain)
  gain.connect(audioContext.destination)
  gain.connect(getMixDestination(audioContext))
  activeMetronome = oscillator
  oscillator.start(now)
  oscillator.stop(now + spec.duration)
}

export function stopMetronome(): void {
  try {
    activeMetronome?.stop()
  } catch {
    /* already ended */
  }
  activeMetronome = null
}

/**
 * Build one recording audio track. Teacher audio feeds the same destination as
 * count samples, avoiding multi-track WebM files that some browsers only play
 * partially. When Web Audio is unavailable, retain the former teacher-only
 * capture as a graceful fallback.
 */
export async function prepareComparisonAudio(
  teacherVideo: HTMLVideoElement,
): Promise<ComparisonAudioMix | null> {
  const capturable = teacherVideo as CapturableVideo
  let teacherStream: MediaStream | undefined
  try {
    teacherStream = capturable.captureStream?.() ?? capturable.mozCaptureStream?.()
  } catch {
    teacherStream = undefined
  }

  const audioContext = getAudioContext()
  if (!audioContext) {
    const directTrack = teacherStream?.getAudioTracks?.()[0]
    return directTrack ? { track: directTrack, cleanup: () => undefined } : null
  }

  await resume(audioContext)
  const destination = getMixDestination(audioContext)
  let teacherSource: MediaStreamAudioSourceNode | null = null
  if (teacherStream?.getAudioTracks?.().length) {
    try {
      teacherSource = audioContext.createMediaStreamSource(teacherStream)
      teacherSource.connect(destination)
    } catch {
      teacherSource = null
    }
  }
  const track = destination.stream.getAudioTracks()[0]
  if (!track) {
    teacherSource?.disconnect()
    return null
  }
  return {
    track,
    cleanup: () => {
      try {
        teacherSource?.disconnect()
      } catch {
        /* already disconnected */
      }
    },
  }
}
