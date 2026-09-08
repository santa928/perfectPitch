/** 評価の入力・実行コード・完走を一箇所で検証する。 */
import { readFileSync, readdirSync } from 'node:fs'
import { createHash } from 'node:crypto'
import type { GroupedClip, Note } from './metrics.ts'
import { validateSplit } from './metrics.ts'

export interface CorpusClip extends GroupedClip {
  duration: number; sampleRate: number; samples: number; kind: string; sha256: Record<string, string>
}
export interface Manifest { tracks: CorpusClip[]; baselineSha: string }

export interface FreezeState {
  sourceHashes: Record<string, string>; configuration: Record<string, unknown>; environment: Record<string, unknown>; manifestSha256: string
}
export interface HoldoutSeal extends FreezeState { kind: 'issue21-holdout-freeze-v1'; frozenAt: string }

/** 通常runのmetadataを凍結済みと扱わず、全評価条件と専用seal識別を確認する。 */
export function validateHoldoutSeal(seal: HoldoutSeal, current: FreezeState): void {
  if (seal.kind !== 'issue21-holdout-freeze-v1' || !Number.isFinite(Date.parse(seal.frozenAt)) || Date.parse(seal.frozenAt) > Date.now())
    throw new Error('Expected an earlier --freeze artifact')
  for (const key of ['sourceHashes', 'configuration', 'environment', 'manifestSha256'] as const)
    if (JSON.stringify(seal[key]) !== JSON.stringify(current[key])) throw new Error(`Holdout ${key} mismatch`)
}

/** 集計後の元結果差し替えを公開前に拒否する。 */
export function validateSummaryInput(summary: { inputSha256: string }, rawBytes: Uint8Array): void {
  if (summary.inputSha256 !== hash(rawBytes)) throw new Error('Summary input hash mismatch')
}

/** バイト列の一致を確認するためのSHA256。 */
export function hash(bytes: Uint8Array | string): string { return createHash('sha256').update(bytes).digest('hex') }

/** 固定manifestを読み、全40件と話者・曲・派生の分割を監査する。 */
export function readManifest(): Manifest {
  const manifest = JSON.parse(readFileSync('docs/evaluation/humming-manifest-v1.json', 'utf8')) as Manifest
  validateSplit(manifest.tracks)
  if (manifest.tracks.length !== 40) throw new Error('Expected 40 vocadito records')
  for (const [split, count] of [['development', 13], ['validation', 13], ['final-holdout', 14]] as const)
    if (manifest.tracks.filter(c => c.split === split).length !== count) throw new Error(`Invalid ${split} count`)
  return manifest
}

/** 派生JSONを信頼せず、固定hashの原CSVから連続音高の正解を直接再構成する。 */
export function readReference(clip: CorpusClip, annotator: 'A1' | 'A2'): Note[] {
  const filename = `notes${annotator}.csv`, bytes = readFileSync(`output/issue21/corpus/${clip.id}/${filename}`)
  if (hash(bytes) !== clip.sha256[filename]) throw new Error('Reference CSV hash mismatch')
  return bytes.toString().trim().split(/\r?\n/).map(line => {
    const [start, hz, duration] = line.split(',').map(Number)
    if (hz <= 0 || !Number.isFinite(hz)) throw new Error('Invalid reference Hz')
    return { start, end: start + duration, midi: 69 + 12 * Math.log2(hz / 440) }
  })
}

/** 実行可能な全srcと評価コード、protocol、依存lock、配布資産をsealへ含める。 */
export function sourceFingerprint(): Record<string, string> {
  const paths = ['docs/evaluation/humming-protocol.md', 'docs/evaluation/humming-manifest-v1.json',
    'package.json', 'package-lock.json', 'vite.config.ts', 'tsconfig.json', 'scripts/evaluation/tsconfig.json',
    'scripts/evaluation/python-environment.txt', 'scripts/fetch-vocadito.py',
    'public/models/basic-pitch.onnx', 'public/runtime/ort-wasm-simd-threaded.wasm',
    'public/runtime/ort-wasm-simd-threaded.mjs', 'public/runtime/ort.wasm.min.mjs']
  const walk = (directory: string): void => {
    for (const item of readdirSync(directory, { withFileTypes: true })) {
      const path = `${directory}/${item.name}`
      if (item.isDirectory() && !item.name.startsWith('__')) walk(path)
      else if (item.isFile() && /\.(ts|js|py)$/.test(item.name)) paths.push(path)
    }
  }
  walk('src'); walk('scripts/evaluation'); walk('tests/fixtures')
  return Object.fromEntries(paths.sort().map(path => [path, hash(readFileSync(path))]))
}

/** 完走していない結果や重複・欠落を最終集計へ混ぜない。 */
export function validateCompletion(expectedIds: readonly string[], rows: readonly { id: string }[], complete: boolean): void {
  const actual = rows.map(r => r.id)
  if (!complete || new Set(actual).size !== actual.length ||
    [...expectedIds].sort().join('\n') !== [...actual].sort().join('\n')) throw new Error('Incomplete or duplicate evaluation rows')
}
