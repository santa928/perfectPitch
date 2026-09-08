/** 保存済み本番出力を再採点する。初期rounded呼出しの引数誤りは明記して再構成する。 */
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { readManifest, readReference, hash, sourceFingerprint, validateCompletion } from './contract.ts'
import { syntheticCorpus } from './synthetic.ts'
import { evaluateNoteEvents, noteDiagnostics, scoreDiagnostics } from './metrics.ts'
import { buildNotes, type PianoNote } from '../../src/analysis/notes.ts'
import { buildScore } from '../../src/notation/score.ts'
import { scoreToPiano } from '../../src/notation/score-playback.ts'
import type { PitchFrame } from '../../src/analysis/pipeline.ts'

const source = process.argv[2], destination = process.argv[3]
if (!resolve(destination).startsWith(resolve('output/issue21') + '/') || existsSync(destination)) throw new Error('Choose a new output directory')
const bytes = readFileSync(`${source}/results.json`)
const report = JSON.parse(bytes.toString())
const manifest = readManifest(), synthetic = syntheticCorpus()
if (report.rows.some((r: { split: string }) => r.split === 'final-holdout')) throw new Error('Do not rescore final holdout with mutable source')
const expectedIds = report.rows[0].kind === 'synthetic' ? synthetic.map(c => c.id) : manifest.tracks.filter(c => c.split === report.rows[0].split).map(c => c.id)
validateCompletion(expectedIds, report.rows, report.complete === true)
mkdirSync(destination, { recursive: true })
for (const row of report.rows) {
  const stages = JSON.parse(readFileSync(`${source}/${row.id}.stages.json`, 'utf8')) as {
    reviewed: PitchFrame[]; stages: Record<string, { notes: PianoNote[]; scoreNotes: PianoNote[]; score: ReturnType<typeof buildScore> }>;
    model: { notes: PianoNote[]; scoreNotes: PianoNote[]; score: ReturnType<typeof buildScore> } | null }
  const notes = buildNotes(stages.reviewed, 'song', 'rounded', row.duration), score = buildScore(notes, row.duration, 120)
  stages.stages.rounded = { notes, score, scoreNotes: scoreToPiano(score).notes.map(n => ({ ...n, start: n.start + score.origin, end: n.end + score.origin })) }
  const generated = synthetic.find(c => c.id === row.id), clip = manifest.tracks.find(c => c.id === row.id)
  const references = generated ? { synthetic: generated.reference } : Object.fromEntries(['A1', 'A2'].map(a => [a, readReference(clip!, a as 'A1' | 'A2')]))
  for (const [method, data] of Object.entries({ ...stages.stages, ...(stages.model ? { basicPitch: stages.model } : {}) })) {
    row.notes[method] = { ...row.notes[method], annotations: Object.fromEntries(Object.entries(references).map(([a, ref]) => [a, {
      performance: evaluateNoteEvents(ref, data.notes), score: evaluateNoteEvents(ref, data.scoreNotes),
      performanceDiagnostics: noteDiagnostics(ref, data.notes, row.duration), scoreReferenceDiagnostics: noteDiagnostics(ref, data.scoreNotes, row.duration) }])),
      quantization: { ...scoreDiagnostics(data.notes, data.scoreNotes, row.duration), omittedNotes: data.score.omittedNotes,
        tieIn: data.score.measures.flat().filter(n => n.tieIn).length, tieOut: data.score.measures.flat().filter(n => n.tieOut).length },
      count: data.notes.length, scoreCount: data.scoreNotes.length }
    // 旧引数誤りのproxyは破棄。F0・YIN・Basic Pitchの生出力は変更しない。
    if (method === 'rounded') delete row.notes[method].noteDerivedF0Proxy
  }
}
writeFileSync(`${destination}/results.json`, JSON.stringify({ ...report, expectedIds, complete: true,
  rescore: { source, inputSha256: hash(bytes), sourceHashes: sourceFingerprint(), correction: 'rounded ablation rebuilt from stored reviewed frames with correct argument order; YIN/Basic Pitch inference unchanged' } }, null, 2))
console.log(`Rescored ${report.rows.length} preserved browser outputs`)
