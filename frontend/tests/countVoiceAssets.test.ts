import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { cwd } from 'node:process'
import { describe, expect, it } from 'vitest'

interface VoiceManifest {
  source: string
  clips: Array<{
    beat: number
    file: string
    durationSeconds: number
    sha256: string
  }>
}

const assetDir = join(cwd(), 'public', 'voice-counts')

describe('custom 1–8 count assets', () => {
  it('ships eight verified user-recorded PCM WAV clips', () => {
    const manifest = JSON.parse(
      readFileSync(join(assetDir, 'manifest.json'), 'utf8'),
    ) as VoiceManifest

    expect(manifest.source).toBe('Stream Bend Way.m4a')
    expect(manifest.clips).toHaveLength(8)

    const hashes = new Set<string>()
    for (const [index, clip] of manifest.clips.entries()) {
      expect(clip.beat).toBe(index + 1)
      expect(clip.file).toBe(`${index + 1}.wav`)

      const wav = readFileSync(join(assetDir, clip.file))
      expect(wav.toString('ascii', 0, 4)).toBe('RIFF')
      expect(wav.toString('ascii', 8, 12)).toBe('WAVE')
      expect(wav.readUInt16LE(22)).toBe(1)
      expect(wav.readUInt32LE(24)).toBe(24_000)
      expect(wav.readUInt16LE(34)).toBe(16)

      const hash = createHash('sha256').update(wav).digest('hex')
      expect(hash).toBe(clip.sha256)
      hashes.add(hash)
      expect(clip.durationSeconds).toBeGreaterThanOrEqual(0.2)
      expect(clip.durationSeconds).toBeLessThanOrEqual(0.65)
    }
    expect(hashes.size).toBe(8)
  })
})
