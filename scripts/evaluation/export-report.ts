/** 公開用に音声・完全注釈・絶対パスを含まない集計と再現hashだけを書き出す。 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { hash, validateSummaryInput, validateCompletion } from './contract.ts'

const names = ['baseline-dev-final', 'baseline-val-v2-audited', 'baseline-synthetic-final', 'rate16-dev-complete',
  'pyin-dev', 'crepe-tiny-dev', 'crepe-full-dev', 'pyin-synthetic', 'crepe-tiny-synthetic', 'crepe-full-synthetic',
  'boundary-v2-dev-final', 'boundary-v2-val-final', 'boundary-v2-synthetic-final', 'final-holdout']
const reports = names.map(name => {
  const path = `output/issue21/${name}/results.summary.json`
  if (!existsSync(path)) throw new Error(`Missing required complete report: ${name}`)
  const bytes = readFileSync(path), summary = JSON.parse(bytes.toString())
  if (!summary.complete) throw new Error('Incomplete summary')
  const rawBytes = readFileSync(`output/issue21/${name}/results.json`)
  validateSummaryInput(summary, rawBytes)
  const raw = JSON.parse(rawBytes.toString())
  validateCompletion(raw.expectedIds ?? [], raw.rows, raw.complete === true)
  for (const method of Object.values(summary.methods) as { perClip: Record<string, unknown>[] }[]) {
    method.perClip = method.perClip.map(c => ({ id: c.id, speaker: c.speaker, scenarios: c.scenarios,
      onsetF1: c.onsetF1, offsetF1: c.offsetF1, scoreF1: c.scoreF1, precision: c.precision, recall: c.recall,
      rests: c.rests, categories: c.categories,
      quantization: Object.fromEntries(Object.entries(c.quantization as Record<string, unknown>).filter(([k]) => !['pairs', 'lostIndices'].includes(k))) }))
  }
  const provenancePath = `output/issue21/${name}/provenance.json`
  return { name, summarySha256: hash(bytes), inferenceReportSha256: hash(readFileSync(`output/issue21/${name}/results.json`)),
    sourceSha: raw.sourceSha ?? null, sourceHashes: raw.sourceHashes, rescore: raw.rescore ?? null,
    legacyAudit: raw.legacyAudit ?? null, holdoutSealSha256: raw.holdoutSealSha256 ?? null,
    environment: raw.environment ?? null, configuration: raw.configuration ?? null,
    provenance: existsSync(provenancePath) ? JSON.parse(readFileSync(provenancePath, 'utf8')) : null,
    timing: raw.rows.map((r: { id: string; duration?: number; timing?: unknown; milliseconds?: number }) => ({ id: r.id, duration: r.duration, timing: r.timing ?? null, boundaryMs: r.milliseconds ?? null })),
    ...summary }
})
const performance = JSON.parse(readFileSync('output/issue21/performance-final.json', 'utf8'))
const seal = JSON.parse(readFileSync('output/issue21/frozen/seal.json', 'utf8'))
const performanceRelevant = (path: string): boolean => path.startsWith('src/') || path.startsWith('public/') ||
  ['package.json', 'package-lock.json', 'vite.config.ts', 'tsconfig.json', 'scripts/evaluation/performance.ts'].includes(path)
const changedSincePerformance = Object.keys(seal.sourceHashes).filter(path => seal.sourceHashes[path] !== performance.sourceHashes[path])
if (changedSincePerformance.some(performanceRelevant)) throw new Error('Performance runtime changed; rerun measurement')
writeFileSync('docs/evaluation/humming-results.json', JSON.stringify({ baselineSha: 'e1f2bbda77097f2b1e807566d64717211bbcd426',
  decision: 'No product candidate adopted; no held-out improvement claim', realHummingRecordings: 0, physicalMobileVerified: false,
  seal, performance, performanceApplicability: { originalArtifactSha256: hash(readFileSync('output/issue21/performance-final.json')),
    unchanged: 'All src, assets, package/lock, Vite/tsconfig and performance runner; original sourceHashes preserved', changedNonRuntimePaths: changedSincePerformance }, reports }, null, 2) + '\n')
writeFileSync('docs/evaluation/humming-failure-traces.json', readFileSync('output/issue21/failure-traces.json'))
console.log('Exported complete aggregates, timing, freeze evidence and development failure traces')
