/** 開発集合の失敗区間だけを抜粋する。音声自体を公開成果物へ含めない。 */
import { readFileSync, writeFileSync } from 'node:fs'
import { readManifest, readReference, hash } from './contract.ts'
import type { PitchFrame } from '../../src/analysis/pipeline.ts'
import type { PianoNote } from '../../src/analysis/notes.ts'

const manifest = readManifest()
const traces = [
  { id: 'vocadito_37', start: 1.5, end: 1.72, reason: 'Continuous pitch transition: accepted F0 survives; event onset is late; Score shifts again' },
  { id: 'vocadito_4', start: .29, end: .51, reason: 'Candidate ambiguity/voicing holes; offline restores some; segmentation drops a remaining 20ms island' },
].map(item => {
  const clip = manifest.tracks.find(c => c.id === item.id)!
  if (clip.split !== 'development') throw new Error('Failure analysis is development only')
  const bytes = readFileSync(`output/issue21/baseline-dev/${item.id}.stages.json`)
  const data = JSON.parse(bytes.toString()) as { live: PitchFrame[]; reviewed: PitchFrame[]; stable: PitchFrame[]; stages: { yin: { notes: PianoNote[]; scoreNotes: PianoNote[] } } }
  const f0Bytes = readFileSync(`output/issue21/corpus/${item.id}/f0.csv`)
  if (hash(f0Bytes) !== clip.sha256['f0.csv']) throw new Error('F0 mismatch')
  const referenceF0 = f0Bytes.toString().trim().split(/\r?\n/).map(line => { const [t, hz] = line.split(',').map(Number); return { t, hz } })
  const inFrame = (f: { t: number }) => f.t >= item.start && f.t <= item.end
  const inNote = (n: { start: number; end: number }) => n.start <= item.end && n.end >= item.start
  return { ...item, sourceStagesSha256: hash(bytes), pcmSourceSha256: clip.sha256['input.wav'],
    annotation: { A1: readReference(clip, 'A1').filter(inNote), A2: readReference(clip, 'A2').filter(inNote), f0: referenceF0.filter(inFrame) },
    rawAndLive: data.live.filter(inFrame), offline: data.reviewed.filter(inFrame), continuity: data.stable.filter(inFrame),
    performance: data.stages.yin.notes.filter(inNote), score: data.stages.yin.scoreNotes.filter(inNote) }
})
writeFileSync('output/issue21/failure-traces.json', JSON.stringify({ source: 'vocadito v3 CC BY 4.0; see humming-manifest-v1.json attribution', traces }, null, 2))
