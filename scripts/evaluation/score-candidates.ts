/** PythonのF0だけを同じ本番melody/Scoreへ渡す。正解は推論終了後の採点に限定する。 */
import { readFileSync, writeFileSync, readdirSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { resolve } from 'node:path'
import { evaluateF0, evaluateNoteEvents, noteDiagnostics, scoreDiagnostics, type Note, type F0 } from './metrics.ts'
import { extractMelody } from '../../src/analysis/melody.ts'
import { buildScore } from '../../src/notation/score.ts'
import { scoreToPiano } from '../../src/notation/score-playback.ts'
import type { PitchFrame } from '../../src/analysis/pipeline.ts'
import { readManifest, readReference, hash, validateCompletion } from './contract.ts'
import { syntheticCorpus } from './synthetic.ts'

const directory = process.argv[2]
if (!directory || !resolve(directory).startsWith(resolve('output/issue21') + '/')) throw new Error('Provide an output/issue21 directory')
const rows = []
const manifest = readManifest()
const synthetic = syntheticCorpus()
for (const file of readdirSync(directory).filter(name => /^(vocadito_\d+|synthetic-[\w-]+)\.json$/.test(name))) {
  const result = JSON.parse(readFileSync(`${directory}/${file}`, 'utf8')) as { id: string; split: string; method: string;
    inputSha256: string; frames: PitchFrame[]; duration: number; inferenceSeconds: number; resampleSeconds: number; peakProcessRssKiB: number }
  if (result.split === 'final-holdout') throw new Error('Exploratory Python scoring cannot access holdout')
  const folder = `output/issue21/corpus/${result.id}`
  const generated = synthetic.find(c => c.id === result.id)
  const clip = manifest.tracks.find(c => c.id === result.id)
  if (!generated && (!clip || clip.split !== result.split)) throw new Error('Unknown or incorrect split')
  if (hash(readFileSync(`${folder}/input48.f32`)) !== result.inputSha256) throw new Error('Candidate PCM mismatch')
  const annotations = generated ? ['Synthetic'] : ['A1', 'A2']
  if (!generated && hash(readFileSync(`${folder}/f0.csv`)) !== clip!.sha256['f0.csv']) throw new Error('F0 hash mismatch')
  const f0: F0[] = generated?.f0 ?? readFileSync(`${folder}/f0.csv`, 'utf8').trim().split(/\r?\n/).map(line => {
    const [t, hz] = line.split(',').map(Number); return { t, hz }
  })
  const notes = extractMelody(result.frames, result.duration), score = buildScore(notes, result.duration, 120)
  const scoreNotes = scoreToPiano(score).notes.map(n => ({ ...n, start: n.start + score.origin, end: n.end + score.origin }))
  const row = { id: result.id, split: result.split, method: result.method, speakerGroup: clip?.speakerGroup ?? result.id,
    f0: evaluateF0(f0, result.frames.map(f => ({ t: f.t, hz: f.frequency })), .01),
    annotations: Object.fromEntries(annotations.map(a => {
      const ref: Note[] = a === 'Synthetic' ? generated!.reference
        : readReference(clip!, a as 'A1' | 'A2')
      return [a, { performance: evaluateNoteEvents(ref, notes), score: evaluateNoteEvents(ref, scoreNotes),
        performanceDiagnostics: noteDiagnostics(ref, notes, result.duration), scoreReferenceDiagnostics: noteDiagnostics(ref, scoreNotes, result.duration) }]
    })), quantization: { ...scoreDiagnostics(notes, scoreNotes, result.duration), omittedNotes: score.omittedNotes,
      tieIn: score.measures.flat().filter(n => n.tieIn).length, tieOut: score.measures.flat().filter(n => n.tieOut).length },
    notes, scoreNotes, timing: { inferenceSeconds: result.inferenceSeconds, resampleSeconds: result.resampleSeconds, peakProcessRssKiB: result.peakProcessRssKiB } }
  rows.push(row)
  writeFileSync(`${directory}/${result.id}.metrics.json`, JSON.stringify(row, null, 2))
}
const sourceHashes = Object.fromEntries(['scripts/evaluation/metrics.ts', 'src/analysis/melody.ts', 'src/analysis/continuity.ts',
  'src/notation/score.ts', 'src/notation/score-playback.ts'].map(file => [file, createHash('sha256').update(readFileSync(file)).digest('hex')]))
const split = rows[0]?.split
const expectedIds = split === 'synthetic' ? synthetic.map(c => c.id) : manifest.tracks.filter(c => c.split === split).map(c => c.id)
validateCompletion(expectedIds, rows, true)
writeFileSync(`${directory}/results.json`, JSON.stringify({ sourceHashes, expectedIds, complete: true, rows }, null, 2))
console.log(`Scored ${rows.length} candidate outputs`)
