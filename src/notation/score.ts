import type { PianoNote } from '../analysis/notes.ts'

export const SCORE_PPQ = 480
export const BEATS_PER_MEASURE = 4
export const MIN_NOTE_TICKS = 15 // 128分音符。内部1tickと表示最小音価は別。
export const MAX_TIMING_ERROR_SECONDS = .05

/** 原音の秒時計とは独立した整数tick。sourceIdは別発音を区別する。 */
export type ScoreEvent = {
  tick: number
  ticks: number
  midi: number | null
  tieIn: boolean
  tieOut: boolean
  sourceId?: number
}
export type SourceNote = PianoNote & { sourceId: number }
export type ScoreIssue = { sourceIds: number[]; reason: string }
export type Score = {
  bpm: number
  origin: number
  measures: ScoreEvent[][]
  omittedNotes: number
  /** 未指定は旧Scoreの4PPQ。新規生成時は必ず480PPQを明示する。 */
  ppq?: number
  sourceNotes?: SourceNote[]
  issues?: ScoreIssue[]
}

/** 旧単位を明示解釈し、未知の単位を誤読しない。 */
export function scorePpq(score: Pick<Score, 'ppq'>): number {
  const ppq = score.ppq ?? 4
  if (ppq !== 4 && ppq !== SCORE_PPQ) throw new RangeError('未対応の楽譜時間単位です。')
  return ppq
}

/** .1+.2 と .3 等の算術丸めだけを同じ境界と扱う。固定の秒幅で実休符を消さない。 */
function sameBoundary(a: number, b: number): boolean {
  return Math.abs(a - b) <= 4 * Number.EPSILON * Math.max(1, Math.abs(a), Math.abs(b))
}

/** 大きい整列音価を優先して小節へ分割し、同じ発音の断片だけにタイを付ける。 */
export function appendScoreInterval(measures: ScoreEvent[][], start: number, end: number,
  midi: number | null, ppq: number, sourceId?: number): void {
  const bar = ppq * BEATS_PER_MEASURE
  const minimum = ppq === SCORE_PPQ ? MIN_NOTE_TICKS : 1
  const values: number[] = []
  for (let value = bar; value >= minimum; value /= 2) values.push(value)
  let tick = start
  while (tick < end) {
    const ticks = values.find(value => value <= end - tick && tick % value === 0)
    if (ticks === undefined) throw new RangeError('音価は128分音符までの拍単位で指定してください。')
    measures[Math.floor(tick / bar)].push({ tick, ticks, midi,
      tieIn: midi !== null && tick > start, tieOut: midi !== null && tick + ticks < end,
      ...(sourceId === undefined ? {} : { sourceId }),
    })
    tick += ticks
  }
}

/**
 * 音符と休符の共有境界を一括配置する。各原時刻の±50ms内だけを探索し、
 * 全ての異なる境界間に正の長さを確保する。局所的な押し出しはしない。
 */
function quantizeBoundaries(times: number[], tickSeconds: number, grid: number): number[] | null {
  type Node = { tick: number; cost: number; parent: Node | null }
  let previous: Node[] = [{ tick: 0, cost: 0, parent: null }]
  for (const time of times.slice(1)) {
    const epsilon = 4 * Number.EPSILON * Math.max(1, Math.abs(time))
    const lower = Math.max(1, Math.ceil((time - MAX_TIMING_ERROR_SECONDS - epsilon) / tickSeconds / grid))
    const upper = Math.floor((time + MAX_TIMING_ERROR_SECONDS + epsilon) / tickSeconds / grid)
    const current: Node[] = []
    for (let unit = lower; unit <= upper; unit++) {
      const tick = unit * grid
      let best: Node | undefined
      for (const candidate of previous)
        if (candidate.tick < tick && (!best || candidate.cost < best.cost)) best = candidate
      if (best) current.push({ tick, cost: best.cost + (tick * tickSeconds - time) ** 2, parent: best })
    }
    if (!current.length) return null
    previous = current
  }
  let node: Node | null = previous.reduce((a, b) => a.cost <= b.cost ? a : b)
  const result: number[] = []
  while (node) { result.push(node.tick); node = node.parent }
  return result.reverse()
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
 * 原音符のコピーを保持し、音符・休符を消さない最も粗いgridへ共同量子化する。
 * 4/4、最初の有効音が1拍目。表現不能な入力は対象・理由・原音符を残す。
 */
export function buildScore(notes: readonly PianoNote[], duration: number, bpm: number): Score {
  if (!Number.isFinite(bpm) || bpm < 40 || bpm > 240 || !Number.isFinite(duration) || duration < 0 || duration > 60.1)
    throw new RangeError('楽譜はBPM 40〜240、録音60秒以内で作成できます。')
  const sourceNotes = notes.map((note, sourceId) => ({ ...note, contour: note.contour.map(point => ({ ...point })), sourceId }))
  const issues: ScoreIssue[] = []
  const valid: SourceNote[] = []
  const candidates: SourceNote[] = []
  for (const note of sourceNotes) {
    if (!Number.isFinite(note.start) || !Number.isFinite(note.end) || !Number.isFinite(note.midi) ||
      note.midi < 21 || note.midi > 108 || note.start < 0 || note.start >= duration || note.end <= note.start) {
      issues.push({ sourceIds: [note.sourceId], reason: '時刻または音高が有効範囲外です。' })
    } else candidates.push(note)
  }
  for (const note of candidates.sort((a, b) => a.start - b.start)) {
    const previousEnd = valid.length ? Math.min(duration, valid.at(-1)!.end) : 0
    if (valid.length && note.start < previousEnd && !sameBoundary(note.start, previousEnd)) {
      issues.push({ sourceIds: [note.sourceId], reason: '前の音符と重なり、単旋律として配置できません。' })
    } else {
      valid.push(note)
      if (note.end > duration)
        issues.push({ sourceIds: [note.sourceId], reason: '録音終端を超える部分は配置できません。原音符の終了を確認してください。' })
    }
  }
  const origin = valid[0]?.start ?? 0
  const score: Score = { bpm, origin, measures: [], omittedNotes: notes.length - valid.length,
    ppq: SCORE_PPQ, sourceNotes, issues }
  if (!sourceNotes.length) return score
  const tickSeconds = 60 / bpm / SCORE_PPQ
  const times = [0]
  /** 浮動小数点の誤差だけを共有境界に寄せ、実際の休符は独立境界として残す。 */
  const boundary = (time: number, noteEnd = false): number => {
    // 音符自身の正の長さは、隣接境界用の浮動小数点許容差で潰さない。
    if (noteEnd || !sameBoundary(times.at(-1)! + origin, time + origin)) times.push(time)
    return times.length - 1
  }
  const intervals = valid.map(note => ({ note, start: boundary(note.start - origin), end: boundary(Math.min(duration, note.end) - origin, true) }))
  // 末尾の実休符も制約へ含め、小節埋めの休符とは区別する。
  boundary(duration - origin)
  let ticks: number[] | null = null
  for (const grid of [120, 60, 30, 15]) {
    ticks = quantizeBoundaries(times, tickSeconds, grid)
    if (ticks) break
  }
  if (!ticks) {
    score.omittedNotes += valid.length
    issues.push({ sourceIds: valid.map(note => note.sourceId), reason: '128分音符と境界誤差50ms以内では音符・休符を全て配置できません。原音符を確認して手直ししてください。' })
  }
  const bar = SCORE_PPQ * BEATS_PER_MEASURE
  const totalTicks = Math.ceil((Math.max(ticks?.at(-1) ?? 0, (duration - origin) / tickSeconds) - 1e-8) / bar) * bar
  score.measures = Array.from({ length: totalTicks / bar }, () => [])
  const append = (start: number, end: number, midi: number | null, sourceId?: number): void =>
    appendScoreInterval(score.measures, start, end, midi, SCORE_PPQ, sourceId)
  let cursor = 0
  for (const { note, start, end } of ticks ? intervals : []) {
    append(cursor, ticks![start], null)
    append(ticks![start], ticks![end], Math.round(note.midi), note.sourceId)
    cursor = ticks![end]
    const sourceLength = Math.min(duration, note.end) - note.start, minimumLength = MIN_NOTE_TICKS * tickSeconds
    if (sourceLength < minimumLength && !sameBoundary(sourceLength, minimumLength))
      issues.push({ sourceIds: [note.sourceId], reason: '原音符が最短の128分音符より短いため、音価を確認してください。' })
  }
  for (let i = 1; i < valid.length; i++) {
    const previous = valid[i - 1], note = valid[i], gap = note.start - previous.end
    if (gap > 0 && !sameBoundary(note.start, previous.end) && gap < MIN_NOTE_TICKS * tickSeconds)
      issues.push({ sourceIds: [previous.sourceId, note.sourceId], reason: '原音符間の休符が最短の128分音符より短いため、間隔を確認してください。' })
  }
  append(cursor, totalTicks, null)
  return score
}
