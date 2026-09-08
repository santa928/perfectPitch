import test from 'node:test'
import assert from 'node:assert/strict'
import { validateCompletion, validateHoldoutSeal, validateSummaryInput, hash } from '../scripts/evaluation/contract.ts'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

test('集計CLIは13/13曲があってもcomplete=falseなら成功結果を作らない', () => {
  const directory = mkdtempSync(join(tmpdir(), 'humming-incomplete-'))
  try {
    const expectedIds = [1, 2, 3, 4, 8, 15, 17, 24, 35, 36, 37, 38, 39].map(n => `vocadito_${n}`)
    const input = join(directory, 'results.json')
    writeFileSync(input, JSON.stringify({ complete: false, expectedIds, rows: expectedIds.map(id => ({ id, split: 'development' })) }))
    const result = spawnSync(process.execPath, ['--experimental-strip-types', 'scripts/evaluation/summarize.ts', input], { encoding: 'utf8' })
    assert.notEqual(result.status, 0)
    assert.match(result.stderr, /Incomplete or duplicate evaluation rows/)
  } finally { rmSync(directory, { recursive: true, force: true }) }
})

test('最終集計で未完走・欠落・重複のholdoutを拒否する', () => {
  assert.throws(() => validateCompletion(['a', 'b'], [{ id: 'a' }], true))
  assert.throws(() => validateCompletion(['a', 'b'], [{ id: 'a' }, { id: 'a' }], true))
  assert.throws(() => validateCompletion(['a'], [{ id: 'a' }], false))
  assert.doesNotThrow(() => validateCompletion(['a', 'b'], [{ id: 'b' }, { id: 'a' }], true))
})
import { evaluateF0, evaluateNoteEvents, scoreDiagnostics, validateSplit } from '../scripts/evaluation/metrics.ts'
import { buildScore } from '../src/notation/score.ts'
import { scoreToPiano } from '../src/notation/score-playback.ts'

test('F0の欠測を正解有声の分母に残し、真の無声への追加を別計算する', () => {
  const result = evaluateF0([{ t: .1, hz: 220 }, { t: .2, hz: 220 }, { t: .3, hz: 0 }],
    [{ t: .1, hz: 220 }, { t: .3, hz: 220 }], .01)
  assert.equal(result.voicedRecall, .5)
  assert.equal(result.accuracy50, .5)
  assert.equal(result.unvoicedFalsePositive, 1)
  assert.equal(result.gtVoiced, 2)
})

test('50ms境界、連続cents、1対1最大照合、offsetを独立に検査する', () => {
  const ref = [{ start: .1, end: 1, midi: 60.49 }]
  const exact = evaluateNoteEvents(ref, [{ start: .15, end: 1, midi: 60 }])
  assert.equal(exact.onset.f1, 1)
  const missed = evaluateNoteEvents(ref, [{ start: .151, end: 1, midi: 60 }])
  assert.equal(missed.onset.f1, 0)
  assert.equal(evaluateNoteEvents([{ ...ref[0], midi: 60.51 }], [{ start: .1, end: 1, midi: 60 }]).onset.f1, 0)
  const duplicate = evaluateNoteEvents(ref, [{ start: .1, end: .4, midi: 60 }, { start: .1, end: .4, midi: 60 }])
  assert.equal(duplicate.onset.tp, 1)
  assert.equal(duplicate.onset.precision, .5)
  assert.equal(duplicate.offset.f1, 0)
})

test('貪欲照合で失う対応も増加路で最大化する', () => {
  const result = evaluateNoteEvents([{ start: .1, end: .2, midi: 60 }, { start: .18, end: .3, midi: 60 }],
    [{ start: .14, end: .3, midi: 60 }, { start: .06, end: .2, midi: 60 }])
  assert.equal(result.onset.tp, 2)
})

test('同一話者・旋律・録音派生のsplit跨ぎを拒否する', () => {
  const first = { id: 'a', split: 'development', speakerGroup: 's1', melodyGroup: 'm1', sourceGroup: 'a' }
  for (const key of ['speakerGroup', 'melodyGroup', 'sourceGroup'] as const) {
    const second = { id: 'b', split: 'validation', speakerGroup: 's2', melodyGroup: 'm2', sourceGroup: 'b', [key]: first[key] }
    assert.throws(() => validateSplit([first, second]), /split/)
  }
})

test('旧C-D-C消失を診断でき、修正後Scoreでは消失しない', () => {
  const notes = [{ start: 0, end: .2, midi: 60 }, { start: .2, end: .3, midi: 62 }, { start: .3, end: 1, midi: 60 }]
    .map(n => ({ ...n, contour: [{ t: n.start, midi: n.midi }] }))
  const score = buildScore(notes, 1, 120)
  const result = scoreDiagnostics(notes, scoreToPiano(score).notes, 1)
  assert.equal(score.omittedNotes, 0)
  assert.equal(result.lost, 0)
  const oldResult = scoreDiagnostics(notes, [{ start: 0, end: 1, midi: 60 }], 1)
  assert.equal(oldResult.lost, 2) // 旧版の誤出力でも診断器自体の検出力を維持する
  assert.equal(result.added, 0)
  assert.equal(evaluateNoteEvents(notes, notes).onset.f1, 1)
})

test('holdoutは専用の過去freezeだけを受理し、各固定条件の改変を拒否する', () => {
  const current = { sourceHashes: { a: 'a' }, configuration: { mode: 'song' }, environment: { node: '24' }, manifestSha256: 'm' }
  const seal = { ...current, kind: 'issue21-holdout-freeze-v1' as const, frozenAt: '2020-01-01T00:00:00Z' }
  assert.doesNotThrow(() => validateHoldoutSeal(seal, current))
  assert.throws(() => validateHoldoutSeal({ ...seal, kind: undefined } as unknown as typeof seal, current))
  assert.throws(() => validateHoldoutSeal({ ...seal, frozenAt: 'invalid' }, current))
  for (const key of ['sourceHashes', 'configuration', 'environment', 'manifestSha256'] as const)
    assert.throws(() => validateHoldoutSeal({ ...seal, [key]: 'changed' }, current))
})

test('集計元結果の1 byte変更を公開前に拒否する', () => {
  const bytes = new TextEncoder().encode('{"complete":true}')
  const summary = { inputSha256: hash(bytes) }
  assert.doesNotThrow(() => validateSummaryInput(summary, bytes))
  assert.throws(() => validateSummaryInput(summary, new TextEncoder().encode('{"complete":true} ')))
})
