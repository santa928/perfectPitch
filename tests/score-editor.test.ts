import { test } from 'node:test'
import assert from 'node:assert/strict'
import { ScoreEditor } from '../src/notation/score-editor.ts'
import { scoreToPiano } from '../src/notation/score-playback.ts'
import type { Score, ScoreEvent } from '../src/notation/score.ts'

/** 手で指定した2小節。最初の音は小節をまたぎ、20tickで同音を再発音する。 */
function tiedScore(): Score {
  return { bpm: 120, origin: 7, omittedNotes: 2, measures: [
    [{ tick: 0, ticks: 16, midi: 60, tieIn: false, tieOut: true }],
    [
      { tick: 16, ticks: 4, midi: 60, tieIn: true, tieOut: false },
      { tick: 20, ticks: 4, midi: 60, tieIn: false, tieOut: false },
      { tick: 24, ticks: 8, midi: null, tieIn: false, tieOut: false },
    ],
  ] }
}

test('editor joins cross-bar ties while preserving same-key reattacks and score metadata', () => {
  const score = tiedScore(), editor = new ScoreEditor(score)
  assert.deepEqual(editor.notes.map(({ tick, ticks, midi }) => [tick, ticks, midi]), [[0, 20, 60], [20, 4, 60]])
  assert.equal(editor.bpm, 120)
  assert.equal(editor.origin, 7)
  assert.equal(editor.totalTicks, 32)
  assert.equal(editor.omittedNotes, 2)
  assert.equal(editor.modified, false)
  assert.equal(editor.canUndo, false)
  assert.equal(editor.canRedo, false)
  assert.deepEqual(editor.score, score)
  editor.edit(editor.notes[0].id, { midi: 62 })
  assert.deepEqual(scoreToPiano(editor.score).notes.map(({ start, end, midi }) => [start, end, midi]), [
    [0, 2.5, 62], [2.5, 3, 60],
  ])
  assert.equal(editor.score.measures[0][0].tieOut, true)
  assert.equal(editor.score.measures[1][0].tieIn, true)
  assert.equal(editor.score.measures[1][1].tieIn, false)
  assert.equal(score.measures[0][0].midi, 60)
})

test('deleting creates rests and inserting one tick preserves bar splitting and stable IDs', () => {
  const editor = new ScoreEditor(tiedScore()), [first, second] = editor.notes
  editor.remove(first.id)
  assert.deepEqual(editor.score.measures[0], [
    { tick: 0, ticks: 16, midi: null, tieIn: false, tieOut: false },
  ])
  const shortId = editor.insert({ tick: 15, ticks: 1, midi: 108 })
  const crossingId = editor.insert({ tick: 16, ticks: 3, midi: 21 })
  assert.deepEqual(editor.notes.map(({ tick, ticks, midi }) => [tick, ticks, midi]), [
    [15, 1, 108], [16, 3, 21], [20, 4, 60],
  ])
  assert.deepEqual(editor.score.measures[1].slice(0, 3), [
    { tick: 16, ticks: 2, midi: 21, tieIn: false, tieOut: true },
    { tick: 18, ticks: 1, midi: 21, tieIn: true, tieOut: false },
    { tick: 19, ticks: 1, midi: null, tieIn: false, tieOut: false },
  ])
  assert.equal(editor.notes.at(-1)?.id, second.id)
  editor.remove(shortId)
  editor.edit(crossingId, { tick: 15, ticks: 5 })
  assert.deepEqual(scoreToPiano(editor.score).notes.map(({ start, end, midi }) => [start, end, midi]), [
    [1.875, 2.5, 21], [2.5, 3, 60],
  ])
  assert.equal(editor.score.measures[0].at(-1)?.tieOut, true)
  assert.equal(editor.score.measures[1][0].tieIn, true)
  editor.remove(crossingId)
  editor.remove(second.id)
  assert.equal(editor.score.measures.length, 2)
  assert.equal(editor.score.measures.flat().every(event => event.midi === null), true)
  assert.equal(scoreToPiano(editor.score).duration, 4)
})

test('invalid edits and inserts are atomic and keep the redo branch available', () => {
  const editor = new ScoreEditor(tiedScore()), firstId = editor.notes[0].id
  editor.edit(firstId, { midi: 61 })
  editor.undo()
  const before = editor.score, beforeNotes = editor.notes
  for (const patch of [
    { tick: -1 }, { tick: .5 }, { tick: NaN }, { tick: Infinity }, { tick: 1 },
    { ticks: 0 }, { ticks: -1 }, { ticks: .5 }, { ticks: 33 },
    { midi: 20 }, { midi: 109 }, { midi: 60.5 }, { midi: NaN },
  ]) {
    assert.throws(() => editor.edit(firstId, patch), RangeError)
    assert.deepEqual(editor.score, before)
    assert.deepEqual(editor.notes, beforeNotes)
    assert.equal(editor.canRedo, true)
    assert.equal(editor.modified, false)
  }
  for (const note of [
    { tick: 20, ticks: 1, midi: 62 }, { tick: 31, ticks: 2, midi: 62 },
    { tick: 24.5, ticks: 1, midi: 62 }, { tick: 24, ticks: 0, midi: 62 },
    { tick: 24, ticks: 1, midi: 109 },
  ]) assert.throws(() => editor.insert(note), RangeError)
  assert.throws(() => editor.edit(9999, { midi: 61 }), RangeError)
  assert.throws(() => editor.remove(9999), RangeError)
  assert.deepEqual(editor.notes, beforeNotes)
  assert.equal(editor.canRedo, true)
  assert.equal(editor.redo(), true)
  assert.equal(editor.notes[0].midi, 61)
})

test('tempo changes seconds only, validates integer BPM and participates in undo and reset', () => {
  const editor = new ScoreEditor(tiedScore()), before = editor.notes
  for (const bpm of [39, 241, 120.5, NaN, Infinity]) assert.throws(() => editor.setTempo(bpm), RangeError)
  assert.equal(editor.canUndo, false)
  editor.setTempo(60)
  assert.deepEqual(editor.notes, before)
  assert.equal(editor.score.bpm, 60)
  assert.deepEqual(scoreToPiano(editor.score).notes.map(({ start, end }) => [start, end]), [[0, 5], [5, 6]])
  assert.equal(editor.modified, true)
  assert.equal(editor.undo(), true)
  assert.equal(editor.bpm, 120)
  assert.equal(editor.modified, false)
  assert.equal(editor.redo(), true)
  editor.reset()
  assert.deepEqual(editor.score, tiedScore())
  assert.equal(editor.modified, false)
  assert.equal(editor.canUndo, false)
  assert.equal(editor.canRedo, false)
  editor.setTempo(40)
  editor.setTempo(240)
  assert.equal(editor.bpm, 240)
})

test('modified compares audible note content rather than operation count or note IDs', () => {
  const editor = new ScoreEditor(tiedScore()), first = editor.notes[0]
  editor.edit(first.id, { midi: 62 })
  editor.edit(first.id, { midi: 60 })
  assert.equal(editor.modified, false)
  editor.remove(first.id)
  const replacement = editor.insert({ tick: first.tick, ticks: first.ticks, midi: first.midi })
  assert.notEqual(replacement, first.id)
  assert.equal(editor.modified, false)
  editor.undo()
  assert.equal(editor.modified, true)
  editor.undo()
  assert.equal(editor.modified, false)
})

test('history is bounded to 50 changes and no-op edits preserve a redo branch', () => {
  const editor = new ScoreEditor(tiedScore())
  for (let bpm = 121; bpm <= 175; bpm++) editor.setTempo(bpm)
  for (let i = 0; i < 50; i++) assert.equal(editor.undo(), true)
  assert.equal(editor.bpm, 125)
  assert.equal(editor.undo(), false)
  editor.setTempo(125)
  editor.edit(editor.notes[0].id, {})
  editor.edit(editor.notes[0].id, { midi: 60 })
  assert.equal(editor.canUndo, false)
  assert.equal(editor.canRedo, true)
  for (let i = 0; i < 50; i++) assert.equal(editor.redo(), true)
  assert.equal(editor.bpm, 175)
  assert.equal(editor.redo(), false)
  editor.undo()
  editor.setTempo(100)
  assert.equal(editor.canRedo, false)
})

test('constructor and getters isolate nested state from external mutations', () => {
  const original = tiedScore(), editor = new ScoreEditor(original)
  original.measures[0][0].midi = 21
  original.measures.push([])
  original.bpm = 40
  const notes = editor.notes, score = editor.score
  notes[0].midi = 108
  notes.splice(1)
  score.measures[0][0].midi = 108
  score.measures.splice(1)
  score.bpm = 240
  assert.deepEqual(editor.score, tiedScore())
  assert.equal(editor.modified, false)
  editor.edit(editor.notes[0].id, { midi: 62 })
  editor.undo()
  assert.deepEqual(editor.score, tiedScore())
})

test('one-sided ties, gaps and explicit rests never merge separate attacks', () => {
  const event = (tick: number, midi: number | null, tieIn: boolean, tieOut: boolean): ScoreEvent =>
    ({ tick, ticks: 2, midi, tieIn, tieOut })
  const score: Score = { bpm: 120, origin: 0, omittedNotes: 0, measures: [[
    event(0, 60, false, true), event(2, 60, false, true), event(5, 60, true, true),
    event(7, null, false, false), event(9, 60, true, true), event(11, 62, true, false),
  ]] }
  const editor = new ScoreEditor(score)
  assert.deepEqual(editor.notes.map(({ tick, ticks, midi }) => [tick, ticks, midi]), [
    [0, 2, 60], [2, 2, 60], [5, 2, 60], [9, 2, 60], [11, 2, 62],
  ])
  assert.deepEqual(scoreToPiano(editor.score), scoreToPiano(score))
})

test('empty scores remain empty and malformed source events are rejected', () => {
  const empty: Score = { bpm: 120, origin: 0, omittedNotes: 0, measures: [] }
  const editor = new ScoreEditor(empty)
  assert.equal(editor.totalTicks, 0)
  assert.deepEqual(editor.notes, [])
  assert.deepEqual(editor.score, empty)
  assert.throws(() => editor.insert({ tick: 0, ticks: 1, midi: 60 }), RangeError)
  assert.equal(editor.modified, false)
  for (const bpm of [39, 241, 120.5, NaN]) assert.throws(() => new ScoreEditor({ ...empty, bpm }), RangeError)
  for (const patch of [{ tick: -1 }, { tick: .5 }, { tick: 1 }, { ticks: 17 }, { midi: 109 }]) {
    const score = tiedScore()
    Object.assign(score.measures[0][0], patch)
    assert.throws(() => new ScoreEditor(score), RangeError)
  }
})
