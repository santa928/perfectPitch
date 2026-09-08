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
  assert.equal(slow.measures[0][0].ticks, 240)
  assert.equal(fast.measures[0][0].ticks, 480)
  assert.equal(fast.measures[0][1].midi, null)
  assert.equal(fast.measures[0][1].ticks, 480)
  assert.deepEqual(input, copy)
})

test('小節を跨ぐロングトーンのみタイで繋ぎ、同音の再発音をタイにしない', () => {
  const score = buildScore([note(0, 2.5), note(2.5, 3)], 3, 120)
  assert.deepEqual(score.measures[0][0], {
    tick: 0, ticks: 1920, midi: 60, tieIn: false, tieOut: true, sourceId: 0,
  })
  assert.equal(score.measures[1][0].tieIn, true)
  assert.equal(score.measures[1][0].tieOut, false)
  assert.equal(score.measures[1][1].tieIn, false)
  for (const measure of score.measures)
    assert.equal(measure.reduce((sum, event) => sum + event.ticks, 0), 1920)
})

test('旧16分gridで消えた短音も正の音価を持ち、最小音価未満は原音符と要確認理由を残す', () => {
  const score = buildScore([note(0, 0.01), note(0.12, 0.24, 62)], 0.5, 120)
  assert.equal(score.omittedNotes, 0)
  assert.deepEqual(score.measures.flat().filter(e => e.midi !== null && !e.tieIn).map(e => e.midi), [60, 62])
  assert.equal(score.issues?.length, 1)
  assert.deepEqual(score.issues?.[0].sourceIds, [0])
  assert.equal(score.sourceNotes?.[0].end, .01)
})

test('音程なしは空Score。不正設定は拒否し、最小音価未満は成功と混同しない', () => {
  assert.deepEqual(buildScore([], 5, 120).measures, [])
  const short = buildScore([note(0, 0.001)], 1, 120)
  assert.equal(short.omittedNotes, 0)
  assert.ok(short.issues?.length)
  assert.equal(short.sourceNotes?.[0].end, .001)
  for (const bpm of [0, NaN, Infinity, 241])
    assert.throws(() => buildScore([], 1, bpm), RangeError)
})

test('60秒・高密度の音符でも各小節は480PPQの4拍分で重複や欠落なく埋まる', () => {
  const input = Array.from({ length: 600 }, (_, i) => note(i / 10, (i + 0.7) / 10, 33 + i % 51))
  const score = buildScore(input, 60, 240)
  assert.equal(score.measures.length, 60)
  let tick = 0
  for (const measure of score.measures) {
    assert.equal(measure.reduce((sum, event) => sum + event.ticks, 0), 1920)
    for (const event of measure) {
      assert.equal(event.tick, tick)
      tick += event.ticks
    }
  }
})
