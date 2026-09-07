import { scoreToPiano } from './score-playback.ts'
import type { Score, ScoreEvent } from './score.ts'

/** タイを結合した1回の発音。tick/ticksは16分音符単位、idは編集履歴を通して安定する。 */
export type EditableNote = { id: number; tick: number; ticks: number; midi: number }
type NoteInput = Omit<EditableNote, 'id'>
type Snapshot = { bpm: number; notes: EditableNote[] }

/** 元の配列・音符から独立した履歴スナップショットを作る。 */
function copySnapshot(snapshot: Snapshot): Snapshot {
  return { bpm: snapshot.bpm, notes: snapshot.notes.map(note => ({ ...note })) }
}

/** IDや記譜上の分割に依存せず、テンポと論理音符の実差分を比較する。 */
function sameContent(a: Snapshot, b: Snapshot): boolean {
  return a.bpm === b.bpm && a.notes.length === b.notes.length && a.notes.every((note, index) => {
    const other = b.notes[index]
    return note.tick === other.tick && note.ticks === other.ticks && note.midi === other.midi
  })
}

/** 編集可能なテンポは40〜240の整数に限る。 */
function validateTempo(bpm: number): void {
  if (!Number.isInteger(bpm) || bpm < 40 || bpm > 240)
    throw new RangeError('テンポは40〜240の整数で指定してください。')
}

/**
 * 小節数を固定した単旋律の編集履歴。休符は音符間の隙間から再構成する。
 * 入出力をコピーし、失敗した編集は現在の譜面・undo/redo履歴を変更しない。
 */
export class ScoreEditor {
  readonly #origin: number
  readonly #totalTicks: number
  readonly #omittedNotes: number
  readonly #original: Snapshot
  #current: Snapshot
  #past: Snapshot[] = []
  #future: Snapshot[] = []
  #nextId: number

  /** 再生と同じタイ規則で論理音符へ変換し、入力Scoreから独立した初期状態を保存する。 */
  constructor(score: Score) {
    validateTempo(score.bpm)
    const { notes } = scoreToPiano(score)
    const tickSeconds = 60 / score.bpm / 4
    this.#origin = score.origin
    this.#totalTicks = score.measures.length * 16
    this.#omittedNotes = score.omittedNotes
    this.#current = { bpm: score.bpm, notes: notes.map((note, id) => {
      // 再生側のタイ判定を共有し、秒表現を元の整数tickへ戻す。
      const tick = Math.round(note.start / tickSeconds)
      return { id, tick, ticks: Math.round(note.end / tickSeconds) - tick, midi: note.midi }
    }) }
    this.#original = copySnapshot(this.#current)
    this.#nextId = notes.length
  }

  /** 論理音符のコピーを時刻順で返す。変更はedit/insert/removeを通す。 */
  get notes(): EditableNote[] { return this.#current.notes.map(note => ({ ...note })) }
  /** 現在のテンポ。tick音価とは独立している。 */
  get bpm(): number { return this.#current.bpm }
  /** 原音における譜面開始位置を保持する。 */
  get origin(): number { return this.#origin }
  /** 初期譜面の全小節長。編集による小節の追加・削除は行わない。 */
  get totalTicks(): number { return this.#totalTicks }
  /** 自動採譜で省略した音符数を保持する。手動編集では増減させない。 */
  get omittedNotes(): number { return this.#omittedNotes }
  /** 最大50件の変更を元に戻せるかを返す。 */
  get canUndo(): boolean { return this.#past.length > 0 }
  /** 元に戻した変更を再適用できるかを返す。 */
  get canRedo(): boolean { return this.#future.length > 0 }
  /** 現在の音符・テンポが初期内容と異なる場合だけtrueを返す。 */
  get modified(): boolean { return !sameContent(this.#original, this.#current) }

  /** 休符を補い、buildScoreと同じ音価・小節分割・タイで新しいScoreを返す。 */
  get score(): Score {
    const measures: ScoreEvent[][] = Array.from({ length: this.#totalTicks / 16 }, () => [])
    /** 拍境界に合わせて2の累乗へ分け、同じ論理音符の断片だけに双方向タイを付ける。 */
    const append = (start: number, end: number, midi: number | null): void => {
      let tick = start
      while (tick < end) {
        const ticks = [16, 8, 4, 2, 1].find(value => value <= end - tick && tick % value === 0)!
        measures[Math.floor(tick / 16)].push({
          tick, ticks, midi, tieIn: midi !== null && tick > start, tieOut: midi !== null && tick + ticks < end,
        })
        tick += ticks
      }
    }
    let cursor = 0
    for (const note of this.#current.notes) {
      append(cursor, note.tick, null)
      append(note.tick, note.tick + note.ticks, note.midi)
      cursor = note.tick + note.ticks
    }
    append(cursor, this.#totalTicks, null)
    return { bpm: this.bpm, origin: this.#origin, omittedNotes: this.#omittedNotes, measures }
  }

  /** 指定IDの音高・開始・長さだけを変更する。不正値や重なりはRangeErrorで拒否する。 */
  edit(id: number, changes: Partial<NoteInput>): void {
    const next = copySnapshot(this.#current)
    const index = this.#indexOf(id)
    const original = next.notes[index]
    next.notes[index] = {
      id, tick: changes.tick ?? original.tick, ticks: changes.ticks ?? original.ticks,
      midi: changes.midi ?? original.midi,
    }
    this.#validateNotes(next.notes)
    this.#commit(next)
  }

  /** 論理音符全体を削除する。空いた区間はscore取得時に休符になる。 */
  remove(id: number): void {
    const index = this.#indexOf(id), next = copySnapshot(this.#current)
    next.notes.splice(index, 1)
    this.#commit(next)
  }

  /** 空いている区間へ1音を追加して新IDを返す。削除・undo・reset後もIDを再利用しない。 */
  insert(note: NoteInput): number {
    const id = this.#nextId, next = copySnapshot(this.#current)
    next.notes.push({ id, tick: note.tick, ticks: note.ticks, midi: note.midi })
    this.#validateNotes(next.notes)
    this.#commit(next)
    this.#nextId++
    return id
  }

  /** 音価tickを維持し、演奏速度だけを変える。同値の指定は履歴を増やさない。 */
  setTempo(bpm: number): void {
    validateTempo(bpm)
    this.#commit({ bpm, notes: this.#current.notes })
  }

  /** 直前の変更を戻す。履歴がなければfalseを返す。 */
  undo(): boolean {
    const previous = this.#past.pop()
    if (!previous) return false
    this.#future.push(this.#current)
    this.#current = previous
    return true
  }

  /** undoで戻した変更を再適用する。履歴がなければfalseを返す。 */
  redo(): boolean {
    const next = this.#future.pop()
    if (!next) return false
    this.#past.push(this.#current)
    this.#current = next
    return true
  }

  /** 初期内容へ戻して履歴を消去する。 */
  reset(): void {
    this.#current = copySnapshot(this.#original)
    this.#past = []
    this.#future = []
  }

  /** 未知IDを明示的に拒否し、他の音符を誤って編集しない。 */
  #indexOf(id: number): number {
    const index = this.#current.notes.findIndex(note => note.id === id)
    if (index < 0) throw new RangeError('編集する音符が見つかりません。')
    return index
  }

  /** 作業用コピーを時刻順に整え、整数・鍵盤範囲・小節総長・重複を検査する。 */
  #validateNotes(notes: EditableNote[]): void {
    notes.sort((a, b) => a.tick - b.tick)
    let end = 0
    for (const note of notes) {
      if (
        !Number.isSafeInteger(note.tick) || !Number.isSafeInteger(note.ticks) || note.ticks <= 0 ||
        note.tick < end || note.tick + note.ticks > this.#totalTicks ||
        !Number.isInteger(note.midi) || note.midi < 21 || note.midi > 108
      ) throw new RangeError('音符は重ならない整数tick、既存小節内の長さ、音高21〜108で指定してください。')
      end = note.tick + note.ticks
    }
  }

  /** 検証済みの変更だけを記録する。同値操作ではredoを捨てず、undo履歴は50件に制限する。 */
  #commit(next: Snapshot): void {
    if (sameContent(this.#current, next)) return
    this.#past.push(this.#current)
    if (this.#past.length > 50) this.#past.shift()
    this.#current = next
    this.#future = []
  }
}
