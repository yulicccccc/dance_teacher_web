import { describe, it, expect } from 'vitest'
import { pickChineseVoice } from '../src/utils/voice'

/** Build a minimal `SpeechSynthesisVoice` stub for a given name/lang. */
function voice(name: string, lang: string): SpeechSynthesisVoice {
  return {
    voiceURI: `urn:${name}`,
    name,
    lang,
    localService: true,
    default: false,
  }
}

describe('pickChineseVoice', () => {
  it('prefers a Neural Chinese voice over plain Chinese/English ones', () => {
    const list = [
      voice('Microsoft Huihui - Chinese (Simplified)', 'zh-CN'),
      voice('Microsoft Yun - Neural Chinese (Simplified)', 'zh-CN'),
      voice('Google US English', 'en-US'),
    ]
    const picked = pickChineseVoice(list)
    expect(picked).not.toBeNull()
    expect(picked?.name).toContain('Neural')
  })

  it('returns null when no Chinese voice is present', () => {
    const list = [voice('Google US English', 'en-US'), voice('Samantha', 'en-US')]
    expect(pickChineseVoice(list)).toBeNull()
  })

  it('treats zh-TW as Chinese', () => {
    const list = [voice('Mei-Jia - Chinese (Traditional)', 'zh-TW')]
    const picked = pickChineseVoice(list)
    expect(picked).not.toBeNull()
    expect(picked?.lang).toBe('zh-TW')
  })

  it('picks the best Chinese voice by keyword priority', () => {
    const list = [
      voice('Google 普通话（中国大陆）', 'zh-CN'),
      voice('Ting-Ting - Chinese', 'zh-CN'),
      voice('Microsoft Yaoyao - Chinese', 'zh-CN'),
    ]
    // "Ting" precedes "Yaoyao"/"Google" in the preference list.
    expect(pickChineseVoice(list)?.name).toBe('Ting-Ting - Chinese')
  })

  it('returns null for an empty voice list', () => {
    expect(pickChineseVoice([])).toBeNull()
  })
})
