import { scoreToLogicalNotes } from './score-playback.ts'
import { scorePpq, type Score } from './score.ts'

type NoteEvent = { tick: number; status: 0x80 | 0x90; midi: number }

/** SMFの最大4byteの可変長整数を生成する。範囲外を丸めたり切り捨てたりしない。 */
function vlq(value: number): number[] {
  if (!Number.isSafeInteger(value) || value < 0 || value > 0x0fffffff)
    throw new RangeError('MIDIで表せる時間の範囲を超えています。')
  const bytes = [value % 128]
  while ((value = Math.floor(value / 128)) > 0) bytes.unshift((value % 128) | 0x80)
  return bytes
}

/**
 * 譜面をSMF format 0、480PPQ、4/4、ピアノprogram 0で書き出す。
 * scoreToLogicalNotesのタイ・休符・再発音規則を共有し、原音originを先頭に加えない。
 * 音量情報のないScoreはvelocity 96で統一する。入力のScoreは変更しない。
 */
export function scoreToMidi(score: Score): Uint8Array {
  const notes = scoreToLogicalNotes(score)
  const scale = 480 / scorePpq(score)
  const events: NoteEvent[] = []
  for (const note of notes) {
    events.push(
      { tick: note.tick * scale, status: 0x90, midi: note.midi },
      { tick: (note.tick + note.ticks) * scale, status: 0x80, midi: note.midi },
    )
  }
  // 同時刻はnote offを先に書き、同じ鍵盤の再発音を消さない。
  events.sort((a, b) => a.tick - b.tick || a.status - b.status)
  const tempo = Math.round(60_000_000 / score.bpm)
  const track: number[] = [
    0, 0xff, 0x51, 3, (tempo >> 16) & 255, (tempo >> 8) & 255, tempo & 255,
    0, 0xff, 0x58, 4, 4, 2, 24, 8,
    0, 0xc0, 0,
  ]
  let cursor = 0
  for (const event of events) {
    track.push(...vlq(event.tick - cursor), event.status, event.midi, event.status === 0x90 ? 96 : 0)
    cursor = event.tick
  }
  track.push(...vlq(score.measures.length * 4 * 480 - cursor), 0xff, 0x2f, 0)
  const result = new Uint8Array(22 + track.length)
  result.set([
    0x4d, 0x54, 0x68, 0x64, 0, 0, 0, 6, 0, 0, 0, 1, 1, 0xe0,
    0x4d, 0x54, 0x72, 0x6b,
  ])
  new DataView(result.buffer).setUint32(18, track.length, false)
  result.set(track, 22)
  return result
}
