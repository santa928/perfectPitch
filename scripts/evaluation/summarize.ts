/** 曲・話者・注釈・シナリオを分離する。完走前のholdoutは集計しない。 */
import { readFileSync, writeFileSync } from 'node:fs'
import { counts, distribution, ratio, type Counts, type noteDiagnostics, type scoreDiagnostics, type evaluateF0 } from './metrics.ts'
import { readManifest, validateCompletion, hash } from './contract.ts'
import { syntheticCorpus } from './synthetic.ts'
import { pathToFileURL } from 'node:url'

type Diagnostic = ReturnType<typeof noteDiagnostics>
type F0 = ReturnType<typeof evaluateF0>
type Annotation = { performance: { onset: Counts; offset: Counts }; score: { onset: Counts; offset: Counts }; performanceDiagnostics: Diagnostic; scoreReferenceDiagnostics?: Diagnostic }
type Quantization = ReturnType<typeof scoreDiagnostics> & { omittedNotes?: number; tieIn?: number; tieOut?: number }
type Method = { annotations: Record<string, Annotation>; quantization: Quantization; noteDerivedF0Proxy?: F0 }
type Row = { id: string; speakerGroup?: string; kind?: string; split: string; method?: string;
  quantization?: Quantization; f0: Record<string, F0> | F0; annotations?: Record<string, Annotation>; notes?: Record<string, Method> }
/** 未定義の平均を0へ置換しない。 */
function mean(values: (number | null)[]) { return distribution(values.filter((x): x is number => x !== null)) }
/** 全照合のTP/FP/FNから再計算する。 */
function micro(metrics: Counts[]) { return counts(metrics.reduce((s, x) => s + x.tp, 0), metrics.reduce((s, x) => s + x.tp + x.fn, 0), metrics.reduce((s, x) => s + x.tp + x.fp, 0)) }
/** 音符注釈の補集合に占める誤占有を測る。 */
function rests(ds: Diagnostic[]) {
  const count = ds.reduce((s, d) => s + d.rests.count, 0), seconds = ds.reduce((s, d) => s + d.rests.seconds, 0)
  const filledSeconds = ds.reduce((s, d) => s + d.rests.filledSeconds, 0)
  return { count, seconds, filledSeconds, microFalseOccupancy: ratio(filledSeconds, seconds), macroFalseOccupancy: mean(ds.map(d => d.rests.falseOccupancy)) }
}
/** 音符macroとduration加重microを明示する。exact100は数学的100ms。 */
function categories(ds: Diagnostic[]) {
  const details = ds.flatMap(d => d.details)
  return Object.fromEntries(['long', 'short', 'exact100', 'reattack'].map(key => {
    const selected = details.filter(d => key === 'exact100' ? Math.abs(d.duration - .1) < 1e-8 : d[key as 'long' | 'short' | 'reattack'])
    const durationSeconds = selected.reduce((s, d) => s + d.duration, 0)
    return [key, { annotationEvents: selected.length, matched: selected.filter(d => d.onsetMatched).length,
      recall: ratio(selected.filter(d => d.onsetMatched).length, selected.length), offsetRecall: ratio(selected.filter(d => d.offsetMatched).length, selected.length),
      noteMacroCoverage: mean(selected.map(d => d.coverage)), durationSeconds,
      durationMicroCoverage: ratio(selected.reduce((s, d) => s + d.duration * d.coverage, 0), durationSeconds),
      gapsOver100ms: selected.filter(d => d.maximumGap > .1 + 1e-8).length,
      extraAttacks: selected.reduce((s, d) => s + Math.max(0, d.overlappingAttacks - 1), 0) }]
  }))
}
/** 欠測を含む正解フレームを分母にする。 */
function f0Aggregate(rows: F0[]) {
  const sum = (key: 'gtVoiced' | 'gtUnvoiced' | 'tp' | 'fp' | 'correct50' | 'octaveErrors') => rows.reduce((s, x) => s + x[key], 0)
  return { gtVoiced: sum('gtVoiced'), gtUnvoiced: sum('gtUnvoiced'), microAccuracy50: ratio(sum('correct50'), sum('gtVoiced')),
    microRecall: ratio(sum('tp'), sum('gtVoiced')), microUnvoicedFP: ratio(sum('fp'), sum('gtUnvoiced')), microOctaveRate: ratio(sum('octaveErrors'), sum('gtVoiced')),
    macroAccuracy50: mean(rows.map(x => x.accuracy50)), macroRecall: mean(rows.map(x => x.voicedRecall)),
    detectedOnlyErrorBins: Object.fromEntries(['within50', 'from50To100', 'from100To600', 'over600'].map(key => [key,
      rows.reduce((s, x) => s + x.detectedOnlyCents.bins[key as keyof F0['detectedOnlyCents']['bins']], 0)])) }
}
/** 保存済み集計値を使わず、完走済みrawから決定的に集計を再構成する。 */
export function summarizeReport(inputBytes: Uint8Array, input: string) {
const report = JSON.parse(Buffer.from(inputBytes).toString()) as { rows: Row[]; complete?: boolean; expectedIds?: string[] }
const manifest = readManifest(), fixtures = syntheticCorpus(), split = report.rows[0]?.split
const expected = split === 'synthetic' || split === 'development-regression' ? fixtures.map(c => c.id) : manifest.tracks.filter(c => c.split === split).map(c => c.id)
if (!expected.length || report.rows.some(r => r.split !== split)) throw new Error('Invalid/mixed split')
validateCompletion(expected, report.rows, report.complete === true)
validateCompletion(expected, (report.expectedIds ?? []).map(id => ({ id })), true)
const methods = report.rows[0]?.method ? [report.rows[0].method] : Object.keys(report.rows[0]?.notes ?? {})
const summary = { input, inputSha256: hash(inputBytes), clips: report.rows.length, speakers: new Set(report.rows.map(r => manifest.tracks.find(c => c.id === r.id)?.speakerGroup ?? r.id)).size,
  split, complete: true, scoreInterpretation: 'Manual 120 BPM; acoustic timing diagnostic, not reference beat/tie accuracy',
  uncertainty: 'Per-clip and speaker-group distributions; small corpus, no population confidence claim', f0: {}, methods: {} as Record<string, unknown> }
for (const method of methods) {
  const collected = report.rows.map(row => ({ row, method: row.method ? { annotations: row.annotations!, quantization: row.quantization! } as Method : row.notes![method] }))
  if (collected.some(c => !c.method?.quantization)) throw new Error('Missing stage diagnostics')
  const annotationNames = [...new Set(collected.flatMap(x => Object.keys(x.method.annotations)))]
  const byAnnotation = Object.fromEntries(annotationNames.map(a => {
    const selected = collected.map(x => x.method.annotations[a])
    if (selected.some(x => !x)) throw new Error('Missing annotator')
    return [a, { ...Object.fromEntries(['performance', 'score'].map(stage => [stage, {
      onsetMacro: mean(selected.map(x => x[stage as 'performance' | 'score'].onset.f1)), offsetMacro: mean(selected.map(x => x[stage as 'performance' | 'score'].offset.f1)),
      onsetMicro: micro(selected.map(x => x[stage as 'performance' | 'score'].onset)), offsetMicro: micro(selected.map(x => x[stage as 'performance' | 'score'].offset)) }])),
      categories: categories(selected.map(x => x.performanceDiagnostics)), rests: rests(selected.map(x => x.performanceDiagnostics)),
      scoreRests: selected.every(x => x.scoreReferenceDiagnostics) ? rests(selected.map(x => x.scoreReferenceDiagnostics!)) : null }]
  }))
  const perClip = collected.map(x => ({ id: x.row.id, speaker: manifest.tracks.find(c => c.id === x.row.id)?.speakerGroup ?? x.row.id,
    scenarios: fixtures.find(c => c.id === x.row.id)?.categories ?? [],
    onsetF1: mean(Object.values(x.method.annotations).map(a => a.performance.onset.f1)).mean,
    offsetF1: mean(Object.values(x.method.annotations).map(a => a.performance.offset.f1)).mean,
    scoreF1: mean(Object.values(x.method.annotations).map(a => a.score.onset.f1)).mean,
    precision: mean(Object.values(x.method.annotations).map(a => a.performance.onset.precision)).mean,
    recall: mean(Object.values(x.method.annotations).map(a => a.performance.onset.recall)).mean,
    categories: categories(Object.values(x.method.annotations).map(a => a.performanceDiagnostics)),
    rests: rests(Object.values(x.method.annotations).map(a => a.performanceDiagnostics)), quantization: x.method.quantization }))
  const numericSums = Object.fromEntries(['lost', 'added', 'falseRests', 'falseRestSeconds', 'filledReferenceRestSeconds', 'performanceReattacks', 'scoreReattacks', 'omittedNotes', 'tieIn', 'tieOut'].map(key => {
    const values = collected.map(x => x.method.quantization[key as keyof Quantization])
    return [key, values.every(v => typeof v === 'number') ? (values as number[]).reduce((s, v) => s + v, 0) : null]
  }))
  summary.methods[method] = { perClip, byAnnotation,
    categories: categories(collected.flatMap(c => Object.values(c.method.annotations).map(a => a.performanceDiagnostics))),
    rests: rests(collected.flatMap(c => Object.values(c.method.annotations).map(a => a.performanceDiagnostics))),
    macro: Object.fromEntries(['onsetF1', 'offsetF1', 'scoreF1', 'precision', 'recall'].map(k => [k, mean(perClip.map(c => c[k as 'onsetF1']))])),
    bySpeaker: Object.fromEntries([...new Set(perClip.map(c => c.speaker))].map(s => {
      const selected = perClip.filter(c => c.speaker === s)
      return [s, { clips: selected.length, onsetF1: mean(selected.map(c => c.onsetF1)), offsetF1: mean(selected.map(c => c.offsetF1)),
        scoreF1: mean(selected.map(c => c.scoreF1)), precision: mean(selected.map(c => c.precision)), recall: mean(selected.map(c => c.recall)),
        restFalseOccupancy: mean(selected.map(c => c.rests.microFalseOccupancy)) }]
    })),
    quantization: numericSums, nativeF0: method === 'basicPitch' ? null : 'see F0 stages',
    noteDerivedF0Proxy: collected.every(c => c.method.noteDerivedF0Proxy) ? f0Aggregate(collected.map(c => c.method.noteDerivedF0Proxy!)) : null }
}
const stages = report.rows[0]?.method ? ['candidate'] : Object.keys(report.rows[0]?.f0 ?? {})
summary.f0 = Object.fromEntries(stages.map(stage => {
  const values = report.rows.map(r => ({ id: r.id, speaker: manifest.tracks.find(c => c.id === r.id)?.speakerGroup ?? r.id,
    metrics: (r.method ? r.f0 : (r.f0 as Record<string, F0>)[stage]) as F0 }))
  return [stage, { ...f0Aggregate(values.map(v => v.metrics)),
    perClip: values.map(v => ({ id: v.id, speaker: v.speaker, accuracy50: v.metrics.accuracy50, voicedRecall: v.metrics.voicedRecall,
      unvoicedFalsePositive: v.metrics.unvoicedFalsePositive, octaveRate: v.metrics.octaveRate, detectedOnlyCents: v.metrics.detectedOnlyCents })),
    bySpeaker: Object.fromEntries([...new Set(values.map(v => v.speaker))].map(s => [s, f0Aggregate(values.filter(v => v.speaker === s).map(v => v.metrics))])) }]
}))
return summary
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const input = process.argv[2], summary = summarizeReport(readFileSync(input), input)
  writeFileSync(input.replace(/\.json$/, '.summary.json'), JSON.stringify(summary, null, 2))
  console.log(JSON.stringify({ clips: summary.clips, split: summary.split, methods: Object.fromEntries(Object.entries(summary.methods).map(([m, data]) => [m, (data as { macro: unknown }).macro])) }))
}
