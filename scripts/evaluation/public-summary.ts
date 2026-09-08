/** 公開時に派生summaryの数値を信頼せず、検証済みrawから集計を作り直す。 */
import { readFileSync } from 'node:fs'
import { summarizeReport } from './summarize.ts'
import { hash, validateSummaryInput } from './contract.ts'

/** 手編集された隣接summaryに影響されず、全aggregateとそのdigestを生成する。 */
export function readPublicSummary(rawPath: string) {
  const rawBytes = readFileSync(rawPath)
  // 旧runからのraw差し替え拒否も維持する。保存済みsummaryから使うのは入力digestだけ。
  const recordedInput = JSON.parse(readFileSync(rawPath.replace(/\.json$/, '.summary.json'), 'utf8')) as { inputSha256?: string }
  if (typeof recordedInput.inputSha256 !== 'string') throw new Error('Missing recorded input digest')
  validateSummaryInput({ inputSha256: recordedInput.inputSha256 }, rawBytes)
  const summary = summarizeReport(rawBytes, rawPath)
  const summarySha256 = hash(JSON.stringify(summary, null, 2))
  for (const method of Object.values(summary.methods) as { perClip: Record<string, unknown>[] }[]) {
    method.perClip = method.perClip.map(c => ({ id: c.id, speaker: c.speaker, scenarios: c.scenarios,
      onsetF1: c.onsetF1, offsetF1: c.offsetF1, scoreF1: c.scoreF1, precision: c.precision, recall: c.recall,
      rests: c.rests, categories: c.categories,
      quantization: Object.fromEntries(Object.entries(c.quantization as Record<string, unknown>).filter(([k]) => !['pairs', 'lostIndices'].includes(k))) }))
  }
  return { summary, summarySha256, rawBytes }
}
