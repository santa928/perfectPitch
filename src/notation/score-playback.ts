import type { PianoNote } from '../analysis/notes.ts'
import { scorePpq, SCORE_PPQ, MIN_NOTE_TICKS, type Score, type ScoreEvent } from './score.ts'

export type LogicalScoreNote = { tick: number; ticks: number; midi: number; sourceId?: number }

/**
 * 譜面の整数tickから1回の打鍵を復元する。原音originや入力は変更しない。
 * 連続同音の双方向タイだけを結び、同音再発音・休符・最後の小節末を保持する。
 * 小節外・重複・不正な音高は拒否する。小節内の空白は発音しない区間として許容する。
 */
export function scoreToLogicalNotes(score: Score): LogicalScoreNote[] {
  if (!Number.isFinite(score.bpm) || score.bpm < 40 || score.bpm > 240)
    throw new RangeError('楽譜の再生にはBPM 40〜240を指定してください。')
  const ppq = scorePpq(score), bar = ppq * 4
  const notes: LogicalScoreNote[] = []
  let previous: ScoreEvent | undefined
  for (const [measureIndex, measure] of score.measures.entries()) {
    let previousEnd = measureIndex * bar
    for (const event of measure) {
      if (
        !Number.isInteger(event.tick) || !Number.isInteger(event.ticks) || event.ticks <= 0 ||
        event.tick < previousEnd || event.tick + event.ticks > (measureIndex + 1) * bar ||
        (ppq === SCORE_PPQ && (event.tick % MIN_NOTE_TICKS !== 0 || !Number.isInteger(Math.log2(event.ticks / MIN_NOTE_TICKS)))) ||
        (event.midi !== null && (!Number.isInteger(event.midi) || event.midi < 21 || event.midi > 108))
      ) throw new RangeError('楽譜の音符は小節内の重ならない整数tickと有効な音高で指定してください。')
      previousEnd = event.tick + event.ticks
      if (event.midi !== null) {
        if (
          previous?.tieOut && event.tieIn && previous.midi === event.midi &&
          previous.sourceId === event.sourceId &&
          previous.tick + previous.ticks === event.tick
        ) notes[notes.length - 1].ticks += event.ticks
        else notes.push({ tick: event.tick, ticks: event.ticks, midi: event.midi,
          ...(event.sourceId === undefined ? {} : { sourceId: event.sourceId }) })
      }
      previous = event
    }
  }
  return notes
}

/** 同じ論理発音を譜面0秒からのピアノ予定へ変換する。原音の時計は変更しない。 */
export function scoreToPiano(score: Score): { notes: PianoNote[]; duration: number } {
  const notes = scoreToLogicalNotes(score), tickSeconds = 60 / score.bpm / scorePpq(score)
  return { notes: notes.map(note => {
    const start = note.tick * tickSeconds
    return { start, end: (note.tick + note.ticks) * tickSeconds, midi: note.midi, contour: [{ t: start, midi: note.midi }] }
  }), duration: score.measures.length * 4 * 60 / score.bpm }
}
