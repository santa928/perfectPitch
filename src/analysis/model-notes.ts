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

function statePath(row: ModelActivity): number[] {
  let costs = new Float64Array(STATE_COUNT)
  const backPointers: Uint8Array[] = []

  for (let frame = 0; frame < row.frames.length; frame += 1) {
    const probabilities = row.frames[frame]
    const onsets = row.onsets[frame]
    const nextCosts = new Float64Array(STATE_COUNT)
    const backPointer = new Uint8Array(STATE_COUNT)
    const maximum = Math.max(...probabilities)

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

/**
 * 固定済みの単音DP候補をPianoNoteへ変換する。
 * 参照音符や既存YIN結果は使わず、休符と明確な同音再発音を保持する。
 */
export function decodeModelMonophonic(row: ModelActivity): PianoNote[] {
  validateActivity(row)
  if (row.frames.length === 0) return []

  const states = statePath(row)
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
