import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readPublicSummary } from '../scripts/evaluation/public-summary.ts'
import { evaluateF0, evaluateNoteEvents, noteDiagnostics, scoreDiagnostics } from '../scripts/evaluation/metrics.ts'
import { hash, readManifest } from '../scripts/evaluation/contract.ts'

test('公開集計は正しいraw hashを残した偽のF1/recall/性能summaryを無視してrawから生成する', () => {
  const directory = mkdtempSync(join(tmpdir(), 'humming-publication-'))
  try {
    const rawPath = join(directory, 'results.json')
    const notes = [{ start: .1, end: .5, midi: 60 }], events = evaluateNoteEvents(notes, notes)
    const expectedIds = readManifest().tracks.filter(c => c.split === 'development').map(c => c.id)
    const raw = JSON.stringify({ complete: true, expectedIds, rows: expectedIds.map(id => ({
      id, split: 'development', f0: { offline: evaluateF0([{ t: .1, hz: 220 }], [{ t: .1, hz: 220 }], .01) },
      notes: { yin: { annotations: { A1: { performance: events, score: events, performanceDiagnostics: noteDiagnostics(notes, notes, 1) } },
        quantization: scoreDiagnostics(notes, notes, 1) } },
    })) })
    writeFileSync(rawPath, raw)
    writeFileSync(join(directory, 'results.summary.json'), JSON.stringify({ inputSha256: hash(raw) }))
    const original = readPublicSummary(rawPath)
    writeFileSync(join(directory, 'results.summary.json'), JSON.stringify({ inputSha256: hash(raw), complete: true,
      methods: { yin: { macro: { onsetF1: 999, recall: 888 } } }, performance: { modelMs: -100 } }))
    assert.deepEqual(readPublicSummary(rawPath), original)
    const method = original.summary.methods.yin as { macro: { onsetF1: { mean: number } } }
    assert.equal(method.macro.onsetF1.mean, 1)
    writeFileSync(rawPath, raw + ' ')
    assert.throws(() => readPublicSummary(rawPath), /hash|SHA|digest/i)
    const incomplete = raw.replace('"complete":true', '"complete":false')
    writeFileSync(rawPath, incomplete)
    writeFileSync(join(directory, 'results.summary.json'), JSON.stringify({ inputSha256: hash(incomplete) }))
    assert.throws(() => readPublicSummary(rawPath), /Incomplete/)
  } finally { rmSync(directory, { recursive: true, force: true }) }
})
