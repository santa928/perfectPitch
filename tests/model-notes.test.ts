import assert from 'node:assert/strict'
import test from 'node:test'
import {
  decodeModelMonophonic,
  ModelNotesError,
  type ModelActivity,
} from '../src/analysis/model-notes.ts'

const KEY_COUNT = 88

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
