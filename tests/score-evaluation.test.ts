import { test } from 'node:test'
import assert from 'node:assert/strict'
import { evaluateNotes, evaluateTempo } from '../scripts/score-evaluation.ts'
import type { ReferenceNote } from '../scripts/score-evaluation.ts'

/** 手計算できる評価用音符を作る。 */
const note = (start: number, end: number, midi = 60): ReferenceNote => ({ start, end, midi })

test('同じ音符列の音高・発音・終了は完全一致し、入力を変更しない', () => {
  const notes = [note(1, 1.5, 62), note(0, 0.5)]
  const before = structuredClone(notes)
  const result = evaluateNotes(notes, notes)
  assert.equal(result.onset.f1, 1)
  assert.equal(result.onsetOffset.f1, 1)
  assert.equal(result.pitchSequence.editDistance, 0)
  assert.deepEqual(notes, before)
})

test('推定音符の重複は正解を使い回さずprecisionと編集距離へ反映する', () => {
  const result = evaluateNotes([note(0, 1)], [note(0, 1), note(0, 1)])
  assert.deepEqual(result.onset, {
    matched: 1, precision: 0.5, recall: 1, f1: 2 / 3,
    falsePositives: 1, falseNegatives: 0,
  })
  assert.equal(result.onsetOffset.matched, 1)
  assert.equal(result.pitchSequence.editDistance, 1)
  assert.equal(result.pitchSequence.normalizedEditDistance, 1)
})

test('1対1照合は近い候補の先取りで一致可能な音符を失わない', () => {
  const result = evaluateNotes(
    [note(0.1, 0.2), note(0.2, 0.3)],
    [note(0.1, 0.25), note(0.15, 0.18)],
  )
  assert.equal(result.onset.matched, 2)
  assert.equal(result.onsetOffset.matched, 2)
})

test('12半音のずれは移調で補正せず不一致として残す', () => {
  const result = evaluateNotes([note(0, 1)], [note(0, 1, 72)])
  assert.equal(result.onset.f1, 0)
  assert.equal(result.onsetOffset.f1, 0)
  assert.equal(result.pitchSequence.editDistance, 1)
})

test('発音100msと終了max100msまたは正解音長20%を別々に適用する', () => {
  assert.equal(evaluateNotes([note(0, 1)], [note(0.1, 1.2)]).onsetOffset.f1, 1)
  const longEnd = evaluateNotes([note(0, 1)], [note(0.1, 1.201)])
  assert.equal(longEnd.onset.f1, 1)
  assert.equal(longEnd.onsetOffset.f1, 0)
  assert.equal(evaluateNotes([note(0, 0.2)], [note(0, 0.3)]).onsetOffset.f1, 1)
  assert.equal(evaluateNotes([note(0, 1)], [note(0.101, 1)]).onset.f1, 0)
})

test('空の音符列と挿入・削除は有限の指標になる', () => {
  assert.equal(evaluateNotes([], []).onset.f1, 1)
  assert.equal(evaluateNotes([], []).pitchSequence.normalizedEditDistance, 0)
  assert.equal(evaluateNotes([], [note(0, 1)]).onset.f1, 0)
  assert.equal(evaluateNotes([note(0, 1)], []).onset.falseNegatives, 1)
  assert.equal(evaluateNotes([note(0, 1)], []).pitchSequence.editDistance, 1)
})

test('音符の非有限値・負時刻・逆転区間・非整数MIDIを拒否する', () => {
  for (const invalid of [note(NaN, 1), note(0, Infinity), note(-0.1, 1),
    note(1, 1), note(2, 1), note(0, 1, 60.5), note(0, 1, 128), note(0, 1, -1)]) {
    assert.throws(() => evaluateNotes([invalid], []), RangeError)
    assert.throws(() => evaluateNotes([], [invalid]), RangeError)
  }
})

test('2倍BPMは通常誤差に残り、倍半分の参考値にだけ分離される', () => {
  const result = evaluateTempo(80, 160)
  assert.equal(result.absoluteError, 80)
  assert.equal(result.relativeError, 1)
  assert.deepEqual(result.octaveReference, {
    referenceMultiplier: 2, comparisonBpm: 160, absoluteError: 0, relativeError: 0,
  })
  assert.equal(evaluateTempo(120, 60).relativeError, 0.5)
  assert.equal(evaluateTempo(120, 120).absoluteError, 0)
})

test('ゼロ・負・非有限BPMは正解側と推定側のどちらも拒否する', () => {
  for (const bpm of [0, -10, NaN, Infinity]) {
    assert.throws(() => evaluateTempo(bpm, 120), RangeError)
    assert.throws(() => evaluateTempo(120, bpm), RangeError)
  }
})
