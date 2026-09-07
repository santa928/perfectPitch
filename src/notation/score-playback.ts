import type { PianoNote } from '../analysis/notes.ts'
import type { Score, ScoreEvent } from './score.ts'

/**
 * 譜面の16分tickを0秒からのピアノ音符へ変換する。原音originや入力は変更しない。
 * 連続同音の双方向タイだけを結び、同音再発音・休符・最後の小節末を保持する。
 * 小節外・重複・不正な音高は拒否する。小節内の空白は発音しない区間として許容する。
 */
export function scoreToPiano(score: Score): { notes: PianoNote[]; duration: number } {
  if (!Number.isFinite(score.bpm) || score.bpm < 40 || score.bpm > 240)
    throw new RangeError('楽譜の再生にはBPM 40〜240を指定してください。')
  const tickSeconds = 60 / score.bpm / 4
  const notes: PianoNote[] = []
  let previous: ScoreEvent | undefined
  for (const [measureIndex, measure] of score.measures.entries()) {
    let previousEnd = measureIndex * 16
    for (const event of measure) {
      if (
        !Number.isInteger(event.tick) || !Number.isInteger(event.ticks) || event.ticks <= 0 ||
        event.tick < previousEnd || event.tick + event.ticks > (measureIndex + 1) * 16 ||
        (event.midi !== null && (!Number.isInteger(event.midi) || event.midi < 21 || event.midi > 108))
      ) throw new RangeError('楽譜の音符は小節内の重ならない整数tickと有効な音高で指定してください。')
      previousEnd = event.tick + event.ticks
      if (event.midi !== null) {
        const start = event.tick * tickSeconds
        const end = (event.tick + event.ticks) * tickSeconds
        if (
          previous?.tieOut && event.tieIn && previous.midi === event.midi &&
          previous.tick + previous.ticks === event.tick
        ) notes[notes.length - 1].end = end
        else notes.push({ start, end, midi: event.midi, contour: [{ t: start, midi: event.midi }] })
      }
      previous = event
    }
  }
  return { notes, duration: score.measures.length * 16 * tickSeconds }
}
