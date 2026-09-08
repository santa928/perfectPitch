/** 公開用に音声・完全注釈・絶対パスを含まない集計と再現hashだけを書き出す。 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { hash, sourceFingerprint } from './contract.ts'
import { readPublicSummary } from './public-summary.ts'

const names = ['baseline-dev-final', 'baseline-val-v2-audited', 'baseline-synthetic-final', 'rate16-dev-complete',
  'pyin-dev', 'crepe-tiny-dev', 'crepe-full-dev', 'pyin-synthetic', 'crepe-tiny-synthetic', 'crepe-full-synthetic',
  'boundary-v2-dev-final', 'boundary-v2-val-final', 'boundary-v2-synthetic-final', 'final-holdout']
const reports = names.map(name => {
  const path = `output/issue21/${name}/results.json`
  if (!existsSync(path)) throw new Error(`Missing required complete report: ${name}`)
  const { summary, summarySha256, rawBytes } = readPublicSummary(path)
  const raw = JSON.parse(rawBytes.toString())
  const provenancePath = `output/issue21/${name}/provenance.json`
  return { name, summarySha256, inferenceReportSha256: hash(rawBytes),
    sourceSha: raw.sourceSha ?? null, sourceHashes: raw.sourceHashes, rescore: raw.rescore ?? null,
    legacyAudit: raw.legacyAudit ?? null, holdoutSealSha256: raw.holdoutSealSha256 ?? null,
    environment: raw.environment ?? null, configuration: raw.configuration ?? null,
    provenance: existsSync(provenancePath) ? JSON.parse(readFileSync(provenancePath, 'utf8')) : null,
    timing: raw.rows.map((r: { id: string; duration?: number; timing?: unknown; milliseconds?: number }) => ({ id: r.id, duration: r.duration, timing: r.timing ?? null, boundaryMs: r.milliseconds ?? null })),
    ...summary }
})
const performancePath = 'output/issue21/performance-cache-corrected.json'
const performance = JSON.parse(readFileSync(performancePath, 'utf8'))
const seal = JSON.parse(readFileSync('output/issue21/frozen/seal.json', 'utf8'))
const performanceRelevant = (path: string): boolean => path.startsWith('src/') || path.startsWith('public/') ||
  ['package.json', 'package-lock.json', 'vite.config.ts', 'tsconfig.json', 'scripts/evaluation/contract.ts',
    'scripts/evaluation/metrics.ts', 'scripts/evaluation/performance.ts', 'scripts/evaluation/performance-server.ts'].includes(path)
const publicationSourceHashes = sourceFingerprint()
const changed = (before: Record<string, string>, after: Record<string, string>): string[] =>
  [...new Set([...Object.keys(before), ...Object.keys(after)])].sort().filter(path => before[path] !== after[path])
const changedSincePerformance = changed(performance.sourceHashes, publicationSourceHashes)
if (changedSincePerformance.some(performanceRelevant)) throw new Error('Performance runtime changed; rerun measurement')
writeFileSync('docs/evaluation/humming-results.json', JSON.stringify({ baselineSha: 'e1f2bbda77097f2b1e807566d64717211bbcd426',
  decision: 'No product candidate adopted; no held-out improvement claim', realHummingRecordings: 0, physicalMobileVerified: false,
  seal, publication: { sourceHashes: publicationSourceHashes, summaryGeneration: 'Recomputed from complete raw reports; saved summaries supply only the recorded input digest, never aggregate values',
    changedSinceHoldout: changed(seal.sourceHashes, publicationSourceHashes),
    scope: 'Post-holdout aggregation/export integrity and performance cache correction only; original seal/raw/inference unchanged' },
  performance, performanceApplicability: { originalArtifactSha256: hash(readFileSync(performancePath)),
    supersededArtifactSha256: hash(readFileSync('output/issue21/performance-final.json')),
    supersededCondition: 'Both original runs had HTTP cache disabled by page.route; second run was same-page reexecution, not warm HTTP cache',
    unchanged: 'All current src, assets, package/lock, Vite/tsconfig and performance runner/helpers match the corrected measurement; original measurement hashes preserved',
    changedNonRuntimePaths: changedSincePerformance }, reports }) + '\n')
writeFileSync('docs/evaluation/humming-failure-traces.json', readFileSync('output/issue21/failure-traces.json'))
console.log('Exported complete aggregates, timing, freeze evidence and development failure traces')
