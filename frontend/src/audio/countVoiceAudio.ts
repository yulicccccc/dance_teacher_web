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

let context: AudioContext | null = null
let mixDestination: MediaStreamAudioDestinationNode | null = null
let activeSource: AudioBufferSourceNode | null = null
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

/** Play one short count to speakers and the recorder's shared mix bus. */
export async function playCountVoice(beat: number): Promise<void> {
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
    source.buffer = buffer
    source.connect(audioContext.destination)
    source.connect(getMixDestination(audioContext))
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
