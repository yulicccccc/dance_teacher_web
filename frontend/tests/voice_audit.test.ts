import { describe, it, expect } from 'vitest'
import { pickChineseVoice } from '../src/utils/voice'

/**
 * Independent QA audit of `pickChineseVoice` — covers branches the original
 * `voice.test.ts` (5 cases) did not exercise: the no-keyword fallback, the
 * priority *ordering* between two preferred keywords, the extra `zh` lang
 * spellings documented in the module, and case-insensitive matching.
 * These cases do NOT duplicate the engineer's tests.
 */

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

describe('pickChineseVoice — QA audit (independent gaps)', () => {
  it('falls back to the FIRST Chinese voice when no preferred keyword matches', () => {
    // None of these names contain a PREFERRED_KEYWORD, so the function must
    // return the first available Chinese voice rather than null or an English one.
    const list = [
      voice('普通话（中国大陆）', 'zh-CN'),
      voice('國語（臺灣）', 'zh-TW'),
      voice('Google US English', 'en-US'),
    ]
    const picked = pickChineseVoice(list)
    expect(picked).not.toBeNull()
    expect(picked?.lang.startsWith('zh')).toBe(true)
    expect(picked?.name).toBe('普通话（中国大陆）')
  })

  it('honours keyword PRIORITY order: Premium beats Ting even when Ting comes first', () => {
    // Premium has a higher priority index than Ting, so the Premium voice must
    // win even though it appears later in the list. This proves the *order*
    // matters, not just "Neural beats non-Neural".
    const list = [
      voice('Ting-Ting - Chinese', 'zh-CN'),
      voice('Microsoft Premium Online - Chinese', 'zh-CN'),
    ]
    const picked = pickChineseVoice(list)
    expect(picked?.name).toContain('Premium')
    expect(picked?.name).not.toContain('Ting')
  })

  it('treats zh-Hans and zh_CN spellings as Chinese (documented variants)', () => {
    for (const lang of ['zh-Hans', 'zh_CN', 'ZH-cn']) {
      const list = [voice('Local Chinese Voice', lang)]
      const picked = pickChineseVoice(list)
      expect(picked, `lang=${lang} should be accepted as Chinese`).not.toBeNull()
      expect(picked?.lang).toBe(lang)
    }
  })

  it('matches keywords and lang case-insensitively', () => {
    const list = [
      voice('azure neural chinese', 'ZH-CN'),
      voice('plain mandarin', 'zh-CN'),
    ]
    const picked = pickChineseVoice(list)
    expect(picked?.name).toContain('neural')
  })

  it('picks the highest-priority keyword regardless of array position', () => {
    // Neural is last in the array but must still win over earlier Yun/Google/Ting
    // voices — confirming the full priority chain, not first-in-array.
    const list = [
      voice('Microsoft Yun - Chinese', 'zh-CN'),
      voice('Google 普通话（中国大陆）', 'zh-CN'),
      voice('Ting-Ting - Chinese', 'zh-CN'),
      voice('Azure Neural Chinese', 'zh-CN'),
    ]
    const picked = pickChineseVoice(list)
    expect(picked?.name).toContain('Neural')
  })
})
