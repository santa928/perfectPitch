import type { PianoNote } from './notes.ts'

const KEY_COUNT = 88
const REST_STATE = KEY_COUNT
const STATE_COUNT = KEY_COUNT + 1
const MIDI_OFFSET = 21
const OPTIONS = Object.freeze({
  transition: 10,
  rest: 10,
  voicedBias: 0.4,
  onset: 0.5,
  renewal: true,
})

export type ModelActivity = {
  frames: number[][]
  onsets: number[][]
  duration: number
}

/** 固定decoderへ渡せないモデル出力を示す検証エラー。 */
export class ModelNotesError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ModelNotesError'
  }
}

function validateActivity(row: ModelActivity): void {
  if (!Number.isFinite(row.duration) || row.duration <= 0 || row.duration > 60) {
    throw new ModelNotesError('モデル出力の音声時間が不正です。')
  }
  if (row.frames.length !== row.onsets.length) {
    throw new ModelNotesError('音高活動と発音活動のフレーム数が一致しません。')
  }
  for (let frame = 0; frame < row.frames.length; frame += 1) {
    const pitches = row.frames[frame]
    const onsets = row.onsets[frame]
    if (pitches.length !== KEY_COUNT || onsets.length !== KEY_COUNT) {
      throw new ModelNotesError('モデル出力は各フレーム88鍵である必要があります。')
    }
    for (let key = 0; key < KEY_COUNT; key += 1) {
      const pitch = pitches[key]
      const onset = onsets[key]
      if (
        !Number.isFinite(pitch) ||
        !Number.isFinite(onset) ||
        pitch < 0 ||
        pitch > 1 ||
        onset < 0 ||
        onset > 1
      ) {
        throw new ModelNotesError('モデル出力の確率が0から1の範囲外です。')
      }
    }
  }
}

/** Spotify Basic Pitchの公開時刻式。86 fpsの窓境界補正を保持する。 */
function frameTime(frame: number): number {
  const windowOffset =
    (256 / 22050) * (172 - (22050 * 2 - 256) / 256) + 0.0018
  return (frame * 256) / 22050 - windowOffset * Math.floor(frame / 172)
}

/** 通常の単音列、または隣接半音の活動も有声の証拠に含めた候補列を求める。 */
function statePath(row: ModelActivity, includeNeighbors = false): number[] {
  let costs = new Float64Array(STATE_COUNT)
  const backPointers: Uint8Array[] = []

  for (let frame = 0; frame < row.frames.length; frame += 1) {
    const probabilities = row.frames[frame]
    const onsets = row.onsets[frame]
    const nextCosts = new Float64Array(STATE_COUNT)
    const backPointer = new Uint8Array(STATE_COUNT)
    let maximum = Math.max(...probabilities)
    if (includeNeighbors) {
      const peak = probabilities.indexOf(maximum)
      // 半音間へ分散した活動を休符の対立候補に使う。音高の観測値は変更しない。
      maximum = Math.min(
        1,
        maximum + (probabilities[peak - 1] ?? 0) + (probabilities[peak + 1] ?? 0),
      )
    }

    for (let state = 0; state < STATE_COUNT; state += 1) {
      const observation =
        state === REST_STATE
          ? -Math.log(Math.max(0.015, 1 - maximum))
          : -Math.log(Math.max(0.015, probabilities[state])) -
            OPTIONS.voicedBias
      let bestCost = Number.POSITIVE_INFINITY
      let bestPreviousState = 0

      for (let previous = 0; previous < STATE_COUNT; previous += 1) {
        const transition =
          previous === state
            ? 0
            : previous === REST_STATE || state === REST_STATE
              ? OPTIONS.rest
              : OPTIONS.transition * (1 - 0.8 * onsets[state])
        const cost = (frame === 0 ? 0 : costs[previous]) + transition
        if (cost < bestCost) {
          bestCost = cost
          bestPreviousState = previous
        }
      }

      nextCosts[state] = bestCost + observation
      backPointer[state] = bestPreviousState
    }

    costs = nextCosts
    backPointers.push(backPointer)
  }

  let state = costs.indexOf(Math.min(...costs))
  const states = new Array<number>(row.frames.length)
  for (let frame = row.frames.length - 1; frame >= 0; frame -= 1) {
    states[frame] = state
    state = backPointers[frame][state]
  }
  return states
}

function nearbyEnergy(row: ModelActivity, frame: number, key: number): number {
  return row.frames[frame]
    .slice(Math.max(0, key - 2), Math.min(KEY_COUNT, key + 3))
    .reduce((sum, value) => sum + value, 0)
}

function renewalBoundaries(
  row: ModelActivity,
  key: number,
  start: number,
  end: number,
): number[] {
  const boundaries = [start]
  if (!OPTIONS.renewal) return [start, end]

  for (let frame = start + 6; frame < end - 4; frame += 1) {
    const peak = row.onsets[frame][key]
    if (
      peak < OPTIONS.onset ||
      frame - boundaries.at(-1)! < 7 ||
      peak <=
        Math.max(
          ...row.onsets
            .slice(Math.max(start, frame - 3), frame)
            .map((values) => values[key]),
        ) ||
      peak <
        Math.max(
          ...row.onsets
            .slice(frame + 1, Math.min(end, frame + 4))
            .map((values) => values[key]),
        )
    ) {
      continue
    }

    const shoulder = Math.min(
      ...row.onsets
        .slice(Math.max(start, frame - 8), frame)
        .map((values) => values[key]),
    )
    if (peak - shoulder < 0.12) continue
    const before = Array.from(
      { length: Math.min(8, frame - start) },
      (_, index) => nearbyEnergy(row, frame - 1 - index, key),
    )
    const after = Array.from(
      { length: Math.min(5, end - frame) },
      (_, index) => nearbyEnergy(row, frame + index, key),
    )
    if (Math.min(...before) > 0.55 * Math.max(...after)) continue
    boundaries.push(frame)
  }

  boundaries.push(end)
  return boundaries
}

/** 状態列を元録音の時刻へ戻し、同音の再発音と入力の時間境界を保つ。 */
function notesFromPath(row: ModelActivity, states: readonly number[]): PianoNote[] {
  const notes: PianoNote[] = []
  for (let start = 0; start < states.length; ) {
    let end = start + 1
    while (end < states.length && states[end] === states[start]) end += 1

    const key = states[start]
    if (key !== REST_STATE) {
      const boundaries = renewalBoundaries(row, key, start, end)
      for (let index = 0; index < boundaries.length - 1; index += 1) {
        const fromFrame = boundaries[index]
        const toFrame = boundaries[index + 1]
        if (toFrame - fromFrame < 3) continue
        const startTime = Math.min(row.duration, Math.max(0, frameTime(fromFrame)))
        const rawDuration = frameTime(toFrame) - frameTime(fromFrame)
        const endTime = Math.min(row.duration, startTime + rawDuration)
        if (endTime <= startTime) continue
        const midi = key + MIDI_OFFSET
        notes.push({
          start: startTime,
          end: endTime,
          midi,
          contour: [{ t: startTime, midi }],
        })
      }
    }
    start = end
  }
  return notes
}

/** 音の立ち上がり付近にある同音/隣接半音の発音証拠を調べる。 */
function onsetEvidence(row: ModelActivity, times: readonly number[], note: PianoNote): number {
  const key = note.midi - MIDI_OFFSET
  let peak = 0
  for (let frame = 0; frame < times.length; frame += 1) {
    if (times[frame] < note.start - 0.035) continue
    if (times[frame] > note.start + 0.1) break
    for (let neighbor = Math.max(0, key - 1); neighbor <= Math.min(KEY_COUNT - 1, key + 1); neighbor += 1) {
      peak = Math.max(peak, row.onsets[frame][neighbor])
    }
  }
  return peak
}

/** 新たな発音を伴わない隣接半音の揺れを、区間内の活動が多い一音へまとめる。 */
function joinRecoveredNotes(
  row: ModelActivity,
  times: readonly number[],
  previous: PianoNote,
  next: PianoNote,
): PianoNote {
  let previousSupport = 0
  let nextSupport = 0
  for (let frame = 0; frame < times.length; frame += 1) {
    if (times[frame] < previous.start) continue
    if (times[frame] >= next.end) break
    previousSupport += row.frames[frame][previous.midi - MIDI_OFFSET]
    nextSupport += row.frames[frame][next.midi - MIDI_OFFSET]
  }
  const midi = nextSupport > previousSupport ? next.midi : previous.midi
  return { start: previous.start, end: next.end, midi, contour: [{ t: previous.start, midi }] }
}

/**
 * 単音DPで採譜し、確かな音符に挟まれた休符だけを再確認する。
 * 補完には持続と発音の両方を要求し、元の音符・冒頭/末尾・真の休符を保つ。
 * 参照譜面・曲名・既存YIN結果を判定へ入力しない。
 */
export function decodeModelMonophonic(row: ModelActivity): PianoNote[] {
  validateActivity(row)
  if (row.frames.length === 0) return []
  const notes = notesFromPath(row, statePath(row))
  const gaps = notes.slice(0, -1)
    .map((note, index) => ({ start: note.end, end: notes[index + 1].start }))
    .filter(gap => gap.end - gap.start >= 0.1)
  if (gaps.length === 0) return notes

  const candidates = notesFromPath(row, statePath(row, true))
  const times = row.frames.map((_, frame) => frameTime(frame))
  const additions: PianoNote[] = []
  for (const gap of gaps) {
    const recovered: PianoNote[] = []
    for (const candidate of candidates) {
      // 元の音符と少しでも重なる候補は追加しない。
      if (candidate.start < gap.start - 1e-8 || candidate.end > gap.end + 1e-8) continue
      const onset = onsetEvidence(row, times, candidate)
      const previous = recovered.at(-1)
      if (
        previous && Math.abs(previous.end - candidate.start) < 1e-8 &&
        Math.abs(previous.midi - candidate.midi) <= 1 && onset < OPTIONS.onset
      ) {
        recovered[recovered.length - 1] = joinRecoveredNotes(row, times, previous, candidate)
      } else if (candidate.end - candidate.start >= 0.1 && onset >= OPTIONS.onset) {
        recovered.push(candidate)
      }
    }
    additions.push(...recovered)
  }
  return [...notes, ...additions].sort((a, b) => a.start - b.start)
}
