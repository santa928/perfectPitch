/** 保存済みYIN出力へ境界候補だけを適用し、原因と効果を段階別に採点する。 */
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { resolve } from 'node:path'
import { refineMelodyBoundaries } from './boundary-candidate.ts'
import { evaluateNoteEvents, noteDiagnostics, scoreDiagnostics, type Note } from './metrics.ts'
import { buildScore } from '../../src/notation/score.ts'
import { scoreToPiano } from '../../src/notation/score-playback.ts'
import type { PianoNote } from '../../src/analysis/notes.ts'
import { readManifest, readReference, hash, sourceFingerprint, validateCompletion } from './contract.ts'
import { syntheticCorpus } from './synthetic.ts'

const directory = process.argv[2], destination = process.argv[3]
if (!directory || !destination || !resolve(destination).startsWith(resolve('output/issue21') + '/') || existsSync(destination))
  throw new Error('Provide baseline directory and new output/issue21 directory')
const baseline = JSON.parse(readFileSync(`${directory}/results.json`, 'utf8')) as { complete: boolean; rows: { id: string; split: string; kind: string; speakerGroup: string; duration: number; f0: unknown }[] }
if (baseline.rows.some(r => r.split === 'final-holdout')) throw new Error('Exploratory candidate cannot access holdout')
const manifest = readManifest(), synthetic = syntheticCorpus()
const split = baseline.rows[0].split
const expectedIds = split === 'development-regression' ? synthetic.map(c => c.id) : manifest.tracks.filter(c => c.split === split).map(c => c.id)
validateCompletion(expectedIds, baseline.rows, baseline.complete === true)
const pcmManifest = JSON.parse(readFileSync(`output/issue21/pcm-${split === 'development-regression' ? 'synthetic' : split}.json`, 'utf8')) as { records: { id: string; sha256: string }[] }
mkdirSync(destination, { recursive: true })
const rows = []
for (const row of baseline.rows) {
  const folder = `output/issue21/corpus/${row.id}`
  const bytes = readFileSync(`${folder}/input48.f32`)
  if (hash(bytes) !== pcmManifest.records.find(c => c.id === row.id)?.sha256) throw new Error('PCM mismatch')
  const pcm = new Float32Array(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength))
  const stages = JSON.parse(readFileSync(`${directory}/${row.id}.stages.json`, 'utf8')) as { stages: { yin: { notes: PianoNote[] } } }
  const start = performance.now(), result = refineMelodyBoundaries(pcm, 48000, stages.stages.yin.notes)
  const milliseconds = performance.now() - start
  const score = buildScore(result.notes, row.duration, 120)
  const scoreNotes = scoreToPiano(score).notes.map(n => ({ ...n, start: n.start + score.origin, end: n.end + score.origin }))
  const annotationNames = row.kind === 'synthetic' ? ['Synthetic'] : ['A1', 'A2']
  const annotations = Object.fromEntries(annotationNames.map(a => {
    const ref: Note[] = a === 'Synthetic' ? synthetic.find(c => c.id === row.id)!.reference : readReference(manifest.tracks.find(c => c.id === row.id)!, a as 'A1' | 'A2')
    return [a, { performance: evaluateNoteEvents(ref, result.notes), score: evaluateNoteEvents(ref, scoreNotes),
      performanceDiagnostics: noteDiagnostics(ref, result.notes, row.duration), scoreReferenceDiagnostics: noteDiagnostics(ref, scoreNotes, row.duration) }]
  }))
  const evaluated = { ...row, notes: { boundary: { annotations,
    quantization: { ...scoreDiagnostics(result.notes, scoreNotes, row.duration), omittedNotes: score.omittedNotes,
      tieIn: score.measures.flat().filter(n => n.tieIn).length, tieOut: score.measures.flat().filter(n => n.tieOut).length } } }, milliseconds }
  rows.push(evaluated)
  writeFileSync(`${destination}/${row.id}.stages.json`, JSON.stringify({ ...result, score, scoreNotes, milliseconds }))
}
const candidateHash = createHash('sha256').update(readFileSync('scripts/evaluation/boundary-candidate.ts')).digest('hex')
writeFileSync(`${destination}/results.json`, JSON.stringify({ baseline: directory, candidateHash, sourceHashes: sourceFingerprint(), expectedIds, complete: true, rows }, null, 2))
console.log(`Evaluated ${rows.length} boundary candidates; ${candidateHash}`)
