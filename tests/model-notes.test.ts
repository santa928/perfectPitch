import assert from 'node:assert/strict'
import test from 'node:test'
import {
  decodeModelMonophonic,
  ModelNotesError,
  type ModelActivity,
} from '../src/analysis/model-notes.ts'

const KEY_COUNT = 88

/** モデル活動を音声や学習済み出力に依存せず組み立てる。 */
function activity(
  length: number,
  duration: number,
  populate: (frame: number, pitches: number[], onsets: number[]) => void,
): ModelActivity {
  const frames: number[][] = []
  const onsets: number[][] = []
  for (let index = 0; index < length; index += 1) {
    const pitches = Array<number>(KEY_COUNT).fill(0)
    const onset = Array<number>(KEY_COUNT).fill(0)
    populate(index, pitches, onset)
    frames.push(pitches)
    onsets.push(onset)
  }
  return { frames, onsets, duration }
}

/** 強い二音の間に、半音へ活動が分散した弱い発音を配置する。 */
function interruptedPhrase(onset = true, glide = false, reattack = false): ModelActivity {
  return activity(100, 1.3, (frame, pitches, onsets) => {
    if (frame >= 2 && frame < 15) pitches[39] = 0.98
    if (frame >= 82 && frame < 98) pitches[44] = 0.98
    if (frame >= 30 && frame < 68) {
      pitches[41] = glide ? (frame < 48 ? 0.52 : 0.26) : 0.4
      pitches[42] = glide ? (frame < 48 ? 0.26 : 0.52) : 0.35
    }
    if (frame === 30 && onset) onsets[41] = 0.9
    if (frame === 48 && reattack) onsets[42] = 0.9
  })
}

test('音符間で半音に活動が分散した持続音を休符として落とさない', () => {
  const row = interruptedPhrase()
  const snapshot = structuredClone(row)
  const notes = decodeModelMonophonic(row)

  assert.deepEqual(notes.map(n => n.midi), [60, 62, 65])
  assert.ok(notes[1].start > 0.3 && notes[1].start < 0.4)
  assert.ok(notes[1].end > 0.75 && notes[1].end < 0.82)
  assert.ok(notes[0].end < notes[1].start && notes[1].end < notes[2].start)
  assert.deepEqual(row, snapshot)
})

test('音符間の低確率活動に発音証拠がなければ休符を保つ', () => {
  assert.deepEqual(decodeModelMonophonic(interruptedPhrase(false)).map(n => n.midi), [60, 65])
})

test('補った音の半音の揺れは新しい発音がなければ一音に保つ', () => {
  const notes = decodeModelMonophonic(interruptedPhrase(true, true))
  assert.deepEqual(notes.map(n => n.midi), [60, 63, 65])
  assert.ok(notes[1].end - notes[1].start > 0.4)
})

test('補った音でも半音への明確な再発音は別の音符にする', () => {
  assert.deepEqual(
    decodeModelMonophonic(interruptedPhrase(true, true, true)).map(n => n.midi),
    [60, 62, 63, 65],
  )
})

test('前後の確かな音符がない低確率活動を自動補完しない', () => {
  for (const [remove, expected] of [
    [[39, 44], []],
    [[39], [65]],
    [[44], [60]],
  ]) {
    const row = interruptedPhrase()
    for (const pitches of row.frames) {
      for (const key of remove) pitches[key] = 0
    }
    assert.deepEqual(decodeModelMonophonic(row).map(n => n.midi), expected)
  }
})

test('休符だけのモデル出力から音符を作らない', () => {
  const notes = decodeModelMonophonic(activity(20, 0.25, () => {}))

  assert.deepEqual(notes, [])
})

test('88鍵の活動をPianoNoteへ変換し入力時間内へ収める', () => {
  const row = activity(20, 0.05, (_frame, pitches) => {
    pitches[39] = 0.98
  })

  const notes = decodeModelMonophonic(row)

  assert.equal(notes.length, 1)
  assert.equal(notes[0].midi, 60)
  assert.equal(notes[0].start, 0)
  assert.equal(notes[0].end, 0.05)
  assert.deepEqual(notes[0].contour, [{ t: 0, midi: 60 }])
})

test('活動が途切れない同音でも明確な再発音を二音へ分ける', () => {
  const row = activity(22, 0.3, (frame, pitches, onsets) => {
    pitches[39] = frame === 9 ? 0.1 : 0.95
    onsets[39] = frame === 10 ? 0.9 : 0.05
  })

  const notes = decodeModelMonophonic(row)

  assert.equal(notes.length, 2)
  assert.deepEqual(notes.map(({ midi }) => midi), [60, 60])
  assert.equal(notes[0].end, notes[1].start)
  assert.ok(notes[0].end > 0)
  assert.ok(notes[1].end <= row.duration)
})

test('不正な行数・鍵数・非finite確率をdecoder境界で拒否する', () => {
  const invalidRows: ModelActivity[] = [
    { frames: [[0]], onsets: [], duration: 1 },
    { frames: [Array(88).fill(0)], onsets: [Array(87).fill(0)], duration: 1 },
    {
      frames: [Array(88).fill(0)],
      onsets: [[Number.NaN, ...Array(87).fill(0)]],
      duration: 1,
    },
  ]

  for (const row of invalidRows) {
    assert.throws(
      () => decodeModelMonophonic(row),
      (error: unknown) => error instanceof ModelNotesError,
    )
  }
})
