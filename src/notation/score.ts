import type { PianoNote } from '../analysis/notes.ts'

/** 1 tick は16分音符。秒時計とは独立した、表示専用の記譜データ。 */
export type ScoreEvent = {
  tick: number
  ticks: number
  midi: number | null
  tieIn: boolean
  tieOut: boolean
}
export type Score = {
  bpm: number
  origin: number
  measures: ScoreEvent[][]
  omittedNotes: number
}

/** 固定ド。異名同音はシャープへ統一し、数字でオクターブを区別する。 */
export function spellPitch(midi: number): { key: string; accidental: string; label: string } {
  const pitch = Math.round(midi)
  const keys = ['c', 'c#', 'd', 'd#', 'e', 'f', 'f#', 'g', 'g#', 'a', 'a#', 'b']
  const names = ['ド', 'ド♯', 'レ', 'レ♯', 'ミ', 'ファ', 'ファ♯', 'ソ', 'ソ♯', 'ラ', 'ラ♯', 'シ']
  const index = ((pitch % 12) + 12) % 12
  const octave = Math.floor(pitch / 12) - 1
  return { key: `${keys[index]}/${octave}`, accidental: keys[index].includes('#') ? '#' : '', label: `${names[index]}${octave}` }
}

/**
 * 音符のコピーを16分単位に丸め、4/4小節へ分割する。最初の検出音が1拍目。
 * 消えた短音は件数を返す。休符を補完し、入力の音高・PCM・再生時刻は変更しない。
 */
export function buildScore(notes: readonly PianoNote[], duration: number, bpm: number): Score {
  if (!Number.isFinite(bpm) || bpm < 40 || bpm > 240 || !Number.isFinite(duration) || duration < 0 || duration > 60.1)
    throw new RangeError('楽譜はBPM 40〜240、録音60秒以内で作成できます。')
  const valid = notes.filter((note) =>
    Number.isFinite(note.start) && Number.isFinite(note.end) && Number.isFinite(note.midi) &&
    note.midi >= 21 && note.midi <= 108 && note.start >= 0 && note.start < duration && note.end > note.start,
  ).sort((a, b) => a.start - b.start)
  const origin = valid[0]?.start ?? 0
  const score: Score = { bpm, origin, measures: [], omittedNotes: 0 }
  const tickSeconds = 60 / bpm / 4
  const intervals: { start: number; end: number; midi: number }[] = []
  let previousEnd = 0
  for (const note of valid) {
    const start = Math.max(previousEnd, Math.round((note.start - origin) / tickSeconds))
    const end = Math.round((Math.min(duration, note.end) - origin) / tickSeconds)
    if (end <= start) { score.omittedNotes++; continue }
    intervals.push({ start, end, midi: Math.round(note.midi) })
    previousEnd = end
  }
  if (!intervals.length) return score
  const totalTicks = Math.ceil(Math.max(previousEnd, Math.round((duration - origin) / tickSeconds)) / 16) * 16
  score.measures = Array.from({ length: totalTicks / 16 }, () => [])
  /** 音価は2の累乗へ分け、拍境界を読みやすくする。音符だけタイを付ける。 */
  const append = (start: number, end: number, midi: number | null): void => {
    let tick = start
    while (tick < end) {
      const ticks = [16, 8, 4, 2, 1].find((value) => value <= end - tick && tick % value === 0)!
      score.measures[Math.floor(tick / 16)].push({ tick, ticks, midi, tieIn: midi !== null && tick > start, tieOut: midi !== null && tick + ticks < end })
      tick += ticks
    }
  }
  let cursor = 0
  for (const interval of intervals) {
    append(cursor, interval.start, null)
    append(interval.start, interval.end, interval.midi)
    cursor = interval.end
  }
  append(cursor, totalTicks, null)
  return score
}
