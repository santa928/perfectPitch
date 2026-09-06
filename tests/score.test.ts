import { test } from 'node:test'
import assert from 'node:assert/strict'
import { buildScore, spellPitch } from '../src/notation/score.ts'
import type { PianoNote } from '../src/analysis/notes.ts'

/** 音声時計の区間を、描画と独立した楽譜入力として用意する。 */
const note = (start: number, end: number, midi = 60): PianoNote => ({
  start, end, midi, contour: [{ t: start, midi }],
})

test('固定ドは半音とオクターブを区別し、C4を中央ドとして綴る', () => {
  assert.deepEqual(spellPitch(60.3), { key: 'c/4', accidental: '', label: 'ド4' })
  assert.deepEqual(spellPitch(61), { key: 'c#/4', accidental: '#', label: 'ド♯4' })
  assert.equal(spellPitch(33).label, 'ラ1')
  assert.equal(spellPitch(83).label, 'シ5')
})

test('表示用のテンポ変更だけで音価が変わり、入力の秒数・連続音高を変更しない', () => {
  const input = [note(0.4, 0.9, 60.3), note(1.4, 1.9, 62)]
  const copy = structuredClone(input)
  const slow = buildScore(input, 2, 60)
  const fast = buildScore(input, 2, 120)
  assert.equal(fast.origin, 0.4)
  assert.equal(slow.measures[0][0].ticks, 2)
  assert.equal(fast.measures[0][0].ticks, 4)
  assert.equal(fast.measures[0][1].midi, null)
  assert.equal(fast.measures[0][1].ticks, 4)
  assert.deepEqual(input, copy)
})

test('小節を跨ぐロングトーンのみタイで繋ぎ、同音の再発音をタイにしない', () => {
  const score = buildScore([note(0, 2.5), note(2.5, 3)], 3, 120)
  assert.deepEqual(score.measures[0][0], {
    tick: 0, ticks: 16, midi: 60, tieIn: false, tieOut: true,
  })
  assert.equal(score.measures[1][0].tieIn, true)
  assert.equal(score.measures[1][0].tieOut, false)
  assert.equal(score.measures[1][1].tieIn, false)
  for (const measure of score.measures)
    assert.equal(measure.reduce((sum, event) => sum + event.ticks, 0), 16)
})

test('グリッドで消える短音は件数を返し、無理に延ばしたり他音へ重ねない', () => {
  const score = buildScore([note(0, 0.01), note(0.12, 0.24, 62)], 0.5, 120)
  assert.equal(score.omittedNotes, 1)
  assert.equal(score.measures[0][0].midi, null)
  assert.equal(score.measures[0][1].midi, 62)
  assert.equal(score.measures[0][1].ticks, 1)
})

test('音程なし・全短音は偽の楽譜を生成しない。不正な設定も拒否する', () => {
  assert.deepEqual(buildScore([], 5, 120).measures, [])
  const short = buildScore([note(0, 0.001)], 1, 120)
  assert.deepEqual(short.measures, [])
  assert.equal(short.omittedNotes, 1)
  for (const bpm of [0, NaN, Infinity, 241])
    assert.throws(() => buildScore([], 1, bpm), RangeError)
})

test('60秒・高密度の音符でも各小節は16分音符16個分で重複や欠落なく埋まる', () => {
  const input = Array.from({ length: 600 }, (_, i) => note(i / 10, (i + 0.7) / 10, 33 + i % 51))
  const score = buildScore(input, 60, 240)
  assert.equal(score.measures.length, 60)
  let tick = 0
  for (const measure of score.measures) {
    assert.equal(measure.reduce((sum, event) => sum + event.ticks, 0), 16)
    for (const event of measure) {
      assert.equal(event.tick, tick)
      tick += event.ticks
    }
  }
})
