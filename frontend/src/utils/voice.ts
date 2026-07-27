/**
 * TTS voice selection for Chinese beat counting.
 *
 * Browsers ship different Chinese voices per OS, and the default one often
 * sounds mechanical. This module centralises the "pick the nicest Chinese
 * voice" logic as a pure, side-effect-free function so it can be unit-tested
 * in isolation and reused anywhere speech synthesis is needed.
 */

/**
 * Keyword fragments that identify higher-quality ("neural"/premium) Chinese
 * voices. Ordered by priority — an earlier match wins. Different platforms
 * preinstall different names:
 *  - macOS: `Ting-Ting`, `Yu`, `Yaoyao`
 *  - Windows: `Microsoft Huihui` / `Yaoyao` / `Xiaoxiao` (some Neural)
 *  - Linux / Chrome: `Google 普通话（中国大陆）`
 *  - Azure-style: voices whose name contains `Neural` / `Premium`
 */
const PREFERRED_KEYWORDS: readonly string[] = [
  'Neural',
  'Premium',
  'Ting',
  'Yaoyao',
  'Yu',
  'Mei-Jia',
  'Xiaoxiao',
  'Google',
  'Yun',
]

/**
 * Returns true when the voice's language code denotes Chinese, tolerating the
 * many spellings browsers use (`zh-CN`, `zh-TW`, `zh_CN`, `zh-Hans`, ...).
 */
function isChineseLang(lang: string): boolean {
  return /^zh/i.test(lang)
}

/**
 * Select the most natural-sounding Chinese voice from the list returned by
 * `window.speechSynthesis.getVoices()`.
 *
 * Strategy:
 *  1. Keep only voices whose `lang` starts with `zh` (covers `zh-CN`/`zh-TW`/...).
 *  2. Among those, return the first voice whose name contains the highest
 *     priority preferred keyword (see {@link PREFERRED_KEYWORDS}).
 *  3. If no preferred keyword matches, fall back to the first Chinese voice.
 *
 * @param voices The live list of installed `SpeechSynthesisVoice`s.
 * @returns The preferred Chinese voice, or `null` when none is available so the
 *   caller can rely on the browser default.
 */
export function pickChineseVoice(
  voices: SpeechSynthesisVoice[],
): SpeechSynthesisVoice | null {
  if (!voices || voices.length === 0) return null

  const chineseVoices = voices.filter((v) => isChineseLang(v.lang))
  if (chineseVoices.length === 0) return null

  for (const keyword of PREFERRED_KEYWORDS) {
    const match = chineseVoices.find((v) =>
      v.name.toLowerCase().includes(keyword.toLowerCase()),
    )
    if (match) return match
  }

  // No premium keyword matched — use the first available Chinese voice.
  return chineseVoices[0]
}
