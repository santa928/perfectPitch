/** complete導入前の開発artifactだけを明示監査する。推論再実行や未知データ扱いはしない。 */
import { readFileSync, writeFileSync, copyFileSync, mkdirSync, existsSync } from 'node:fs'
import { resolve } from 'node:path'
import assert from 'node:assert/strict'
import { readManifest, hash, validateCompletion } from './contract.ts'
import { syntheticCorpus, floatWav } from './synthetic.ts'

const source = process.argv[2], destination = process.argv[3]
const allowed = ['output/issue21/baseline-dev', 'output/issue21/baseline-synthetic', 'output/issue21/rate16-dev']
if (!allowed.includes(source) || !resolve(destination).startsWith(resolve('output/issue21') + '/') || existsSync(destination))
  throw new Error('Only the three documented historical development runs can be audited into a new directory')
const rawBytes = readFileSync(`${source}/results.json`), report = JSON.parse(rawBytes.toString())
if (report.complete !== undefined || !Array.isArray(report.pageErrors) || report.pageErrors.length || !Array.isArray(report.blockedRequests) || report.blockedRequests.length)
  throw new Error('Legacy run has errors, blocked requests, or already has a completion flag')
const manifest = readManifest(), synthetic = syntheticCorpus()
const expectedIds = source.endsWith('synthetic') ? synthetic.map(c => c.id) : manifest.tracks.filter(c => c.split === 'development').map(c => c.id)
validateCompletion(expectedIds, report.rows, true)
const artifactHashes: Record<string, string> = { 'results.json': hash(rawBytes) }
for (const row of report.rows) {
  if (!['development', 'development-regression'].includes(row.split)) throw new Error('Legacy audit cannot access validation/holdout')
  const metricsBytes = readFileSync(`${source}/${row.id}.metrics.json`), stagesBytes = readFileSync(`${source}/${row.id}.stages.json`)
  assert.deepEqual(JSON.parse(metricsBytes.toString()), row, 'Final checkpoint does not equal per-clip metrics')
  const stages = JSON.parse(stagesBytes.toString())
  if (stages.duration !== row.duration || !Array.isArray(stages.reviewed) || !Array.isArray(stages.live) || !stages.stages?.yin ||
      (report.configuration.model && !stages.model)) throw new Error('Missing/inconsistent inference stages')
  const clip = manifest.tracks.find(c => c.id === row.id)
  if (clip && row.audioSha256 !== clip.sha256['input.wav']) throw new Error('Original audio hash mismatch')
  const generated = synthetic.find(c => c.id === row.id)
  if (generated && row.audioSha256 !== hash(floatWav(generated.samples, generated.sampleRate))) throw new Error('Synthetic input hash mismatch')
  for (const [suffix, bytes] of [['metrics.json', metricsBytes], ['stages.json', stagesBytes]] as const) artifactHashes[`${row.id}.${suffix}`] = hash(bytes)
}
mkdirSync(destination, { recursive: true })
for (const filename of Object.keys(artifactHashes).filter(f => f !== 'results.json')) copyFileSync(`${source}/${filename}`, `${destination}/${filename}`)
writeFileSync(`${destination}/results.json`, JSON.stringify({ ...report, complete: true, expectedIds,
  legacyAudit: { source, artifactHashes, checks: ['exact expected IDs', 'empty captured page errors and blocked requests', 'per-clip metrics equal checkpoint', 'all stages present', 'original audio hashes'],
    limitation: 'Historical development inference; completion is verified from artifacts, not a newly executed or held-out run' } }, null, 2))
console.log(`Audited historical content completion: ${source}`)
