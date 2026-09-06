/** SoundFontの代入文からJSONだけを読み、外部JavaScriptを実行しない。 */
export function parseSoundfont(text: string): Record<string, string> {
  const match = text.match(
    /MIDI\.Soundfont\.[a-z_]+\s*=\s*(\{[\s\S]*\})\s*;?\s*$/i,
  )
  if (!match) throw new Error('ピアノ音源の形式を確認できません。')
  const value: unknown = JSON.parse(match[1].replace(/,\s*}\s*$/, '}'))
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('音源が不正です。')
  const entries = Object.entries(value)
  if (
    !entries.length ||
    entries.some(
      ([key, item]) =>
        !/^[A-G]b?\d$/.test(key) ||
        typeof item !== 'string' ||
        !/^data:audio\/(mp3|mpeg);base64,[A-Za-z0-9+/=]+$/.test(item),
    )
  ) {
    throw new Error('音源が不正です。')
  }
  return Object.fromEntries(entries) as Record<string, string>
}
/** サンプル基準音からの連続音高比。 */
export function rateForMidi(midi: number, sampleMidi: number): number {
  return 2 ** ((midi - sampleMidi) / 12)
}
/** 原音とピアノが共有する再生位置。予約開始前と終了後を範囲内に収める。 */
export function playbackPosition(
  now: number,
  start: number,
  offset: number,
  duration: number,
): number {
  return Math.min(duration, offset + Math.max(0, now - start))
}
