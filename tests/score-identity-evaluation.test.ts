import test from 'node:test'
import assert from 'node:assert/strict'
import { buildScore } from '../src/notation/score.ts'
import { scoreToPiano } from '../src/notation/score-playback.ts'
import { evaluateNoteEvents } from '../scripts/evaluation/metrics.ts'
import { scoreIdentityDiagnostics, summarizeIdentity, verifyStoredScoreInput } from '../scripts/evaluation/compare-score.ts'

test('ID診断は実MIDI・正長を検証し、IDだけの保持と音高変更を成功に混ぜない', () => {
  const score = buildScore([{ start: 0, end: .5, midi: 60, contour: [] }], 1, 120)
  assert.equal(scoreIdentityDiagnostics(score).lost, 0)
  assert.equal(summarizeIdentity([scoreIdentityDiagnostics(score)]).pass, true)
  score.measures[0][0].midi = 62
  assert.equal(scoreIdentityDiagnostics(score).changedPitches, 1)
  assert.equal(summarizeIdentity([scoreIdentityDiagnostics(score)]).pass, false)
  score.measures[0][0].sourceId = 99
  assert.equal(scoreIdentityDiagnostics(score).lost, 1)
  assert.equal(scoreIdentityDiagnostics(score).added, 1)
  score.measures[0][0].ticks = 0
  assert.throws(() => scoreIdentityDiagnostics(score), RangeError)
})

test('比較要約は重複・誤差超過・要確認を無条件の成功にしない', () => {
  const result = scoreIdentityDiagnostics(buildScore([{ start: 0, end: .5, midi: 60, contour: [] }], 1, 120))
  assert.equal(summarizeIdentity([{ ...result, duplicateAttacks: 1 }]).pass, false)
  assert.equal(summarizeIdentity([{ ...result, maxOffsetError: .051 }]).pass, false)
  const warning = summarizeIdentity([{ ...result, issues: [{ sourceIds: [0], reason: '要確認' }] }])
  assert.equal(warning.preserved, true)
  assert.equal(warning.pass, false)
  assert.equal(warning.reviewIssues, 1)
})

test('ID診断も旧4PPQの拍時計を正しくMIDI tickと秒へ換算する', () => {
  const score = { bpm: 120, origin: 0, omittedNotes: 0,
    sourceNotes: [{ start: .5, end: 1, midi: 60, contour: [], sourceId: 0 }],
    measures: [[{ tick: 4, ticks: 4, midi: 60, sourceId: 0, tieIn: false, tieOut: false }]] }
  const result = scoreIdentityDiagnostics(score)
  assert.equal(result.maxOnsetError, 0)
  assert.equal(result.maxOffsetError, 0)
})

test('保存stageの改変を既存rawの採点との照合で拒否する', () => {
  const notes = [{ start: 0, end: .5, midi: 60, contour: [] }], score = buildScore(notes, 1, 120)
  const stage = { notes, score, scoreNotes: scoreToPiano(score).notes }
  const recorded = { performance: evaluateNoteEvents(notes, notes), score: evaluateNoteEvents(notes, stage.scoreNotes) }
  assert.doesNotThrow(() => verifyStoredScoreInput(stage, 1, buildScore, scoreToPiano, notes, recorded))
  const corrupt = structuredClone(stage)
  corrupt.notes[0].midi = 62
  assert.throws(() => verifyStoredScoreInput(corrupt, 1, buildScore, scoreToPiano, notes, recorded))
  const forged = structuredClone(recorded)
  forged.performance.onset.f1 = .123
  assert.throws(() => verifyStoredScoreInput(stage, 1, buildScore, scoreToPiano, notes, forged))
})
