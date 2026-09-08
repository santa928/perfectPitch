import { test } from 'node:test'
import assert from 'node:assert/strict'
import { buildScore, type Score, type ScoreEvent } from '../src/notation/score.ts'
import { scoreToPiano } from '../src/notation/score-playback.ts'

test('score playback joins ties across bars, preserves reattacks and starts at score zero', () => {
  const score = buildScore([
    { start: 1, end: 3.5, midi: 60, contour: [] },
    { start: 3.5, end: 4, midi: 60, contour: [] },
  ], 4, 120)
  const before = structuredClone(score)
  const result = scoreToPiano(score)
  assert.deepEqual(result, {
    notes: [
      { start: 0, end: 2.5, midi: 60, contour: [{ t: 0, midi: 60 }] },
      { start: 2.5, end: 3, midi: 60, contour: [{ t: 2.5, midi: 60 }] },
    ],
    duration: 4,
  })
  assert.deepEqual(score, before)
  assert.equal(score.origin, 1)
})

test('score playback preserves rests and changes seconds with the displayed tempo', () => {
  const score = buildScore([
    { start: 0, end: .5, midi: 60, contour: [] },
    { start: 1, end: 1.5, midi: 62, contour: [] },
  ], 1.5, 120)
  const result = scoreToPiano({ ...score, bpm: 60 })
  assert.equal(result.duration, 4)
  assert.deepEqual(result.notes.map(({ start, end, midi }) => [start, end, midi]), [
    [0, 1, 60], [2, 3, 62],
  ])
  assert.deepEqual(scoreToPiano(buildScore([], 2, 120)), { notes: [], duration: 0 })
})

test('省略後の同音結合という旧仕様を廃止し、短い別音・休符・再発音を全て残す', () => {
  const note = (start: number, end: number, midi: number) => ({ start, end, midi, contour: [] })
  for (const input of [
    [note(0, .46, 60), note(.46, .48, 48), note(.48, 1, 60)],
    [note(0, .45, 60), note(.45, .46, 48), note(.5, 1, 60)],
    [note(0, .45, 60), note(.46, .47, 48), note(.47, .48, 49), note(.48, 1, 60)],
    [note(0, .46, 60), note(.46, .48, 60), note(.48, 1, 60)],
    [note(0, .5, 60), note(.5, 1, 60)],
  ]) {
    const before = structuredClone(input), score = buildScore(input, 1, 120)
    assert.equal(score.omittedNotes, 0)
    assert.deepEqual(scoreToPiano(score).notes.map(n => n.midi), input.map(n => n.midi))
    assert.deepEqual(input, before)
  }
})

test('tie flags alone cannot join a rest, gap or different pitch', () => {
  const score: Score = { bpm: 120, origin: 0, omittedNotes: 0, measures: [[
    { tick: 0, ticks: 2, midi: 60, tieIn: false, tieOut: true },
    { tick: 2, ticks: 2, midi: null, tieIn: false, tieOut: false },
    { tick: 4, ticks: 2, midi: 60, tieIn: true, tieOut: true },
    { tick: 7, ticks: 1, midi: 60, tieIn: true, tieOut: true },
    { tick: 8, ticks: 4, midi: 62, tieIn: true, tieOut: true },
    { tick: 12, ticks: 4, midi: 62, tieIn: false, tieOut: false },
  ]] }
  assert.equal(scoreToPiano(score).notes.length, 5)
})

test('score playback rejects events outside their measure, invalid timing and invalid pitches', () => {
  const valid: ScoreEvent = { tick: 0, ticks: 4, midi: 60, tieIn: false, tieOut: false }
  const invalid: Partial<ScoreEvent>[] = [
    { tick: 20 }, { tick: 14, ticks: 4 }, { tick: -1 }, { tick: .5 }, { tick: NaN },
    { ticks: 0 }, { ticks: -1 }, { ticks: .5 }, { ticks: Infinity },
    { midi: NaN }, { midi: Infinity }, { midi: 20 }, { midi: 60.5 }, { midi: 109 },
  ]
  for (const values of invalid) {
    const score: Score = { bpm: 120, origin: 0, omittedNotes: 0, measures: [[{ ...valid, ...values }]] }
    assert.throws(() => scoreToPiano(score), RangeError, JSON.stringify(values))
  }
  const wrongMeasure: Score = { bpm: 120, origin: 0, omittedNotes: 0, measures: [[], [valid]] }
  assert.throws(() => scoreToPiano(wrongMeasure), RangeError)
})

test('score playback rejects overlapping and out-of-order events while allowing gaps', () => {
  const event = { ticks: 4, midi: 60, tieIn: false, tieOut: false }
  for (const ticks of [[0, 2], [8, 0]]) {
    const score: Score = { bpm: 120, origin: 0, omittedNotes: 0,
      measures: [ticks.map((tick) => ({ ...event, tick }))] }
    assert.throws(() => scoreToPiano(score), RangeError)
  }
  const score: Score = { bpm: 120, origin: 0, omittedNotes: 0,
    measures: [[{ ...event, tick: 0 }, { ...event, tick: 8 }]] }
  assert.deepEqual(scoreToPiano(score).notes.map(({ start, end }) => [start, end]), [[0, .5], [1, 1.5]])
})
