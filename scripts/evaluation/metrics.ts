/** Issue #21専用の標準50ms評価。旧100ms評価の結果・契約は変更しない。 */
export interface Note { start: number; end: number; midi: number }
export interface F0 { t: number; hz: number | null }
export interface GroupedClip { id: string; split: string; speakerGroup: string; melodyGroup: string; sourceGroup: string }
export interface Counts { tp: number; fp: number; fn: number; precision: number | null; recall: number | null; f1: number | null }

/** 分母0は未定義として保持し、無音だけで平均精度を上げない。 */
export function ratio(a: number, b: number): number | null { return b ? a / b : null }

/** TP/FP/FNからmicroにも使える計数を生成する。 */
export function counts(tp: number, references: number, estimates: number): Counts {
  return { tp, fp: estimates - tp, fn: references - tp,
    precision: ratio(tp, estimates), recall: ratio(tp, references), f1: ratio(2 * tp, references + estimates) }
}

/** 空集合を捏造せず、経験分位点と符号付き/絶対誤差の分布を返す。 */
export function distribution(values: readonly number[]) {
  const sorted = [...values].sort((a, b) => a - b)
  const quantile = (p: number): number | null => sorted.length ? sorted[Math.floor((sorted.length - 1) * p)] : null
  return { n: sorted.length, mean: ratio(sorted.reduce((a, b) => a + b, 0), sorted.length),
    min: quantile(0), p05: quantile(.05), p50: quantile(.5), p95: quantile(.95), max: quantile(1) }
}

/** ID重複や空groupを拒否し、話者/旋律/元録音の連結成分をsplit間で共有させない。 */
export function validateSplit(clips: readonly GroupedClip[]): void {
  const ids = new Set<string>()
  const groups = new Map<string, string>()
  for (const clip of clips) {
    if (!clip.id || !clip.split || ids.has(clip.id)) throw new Error('duplicate/empty split ID')
    ids.add(clip.id)
    for (const key of ['speakerGroup', 'melodyGroup', 'sourceGroup'] as const) {
      if (!clip[key]) throw new Error(`empty split group: ${clip.id}.${key}`)
      const group = `${key}:${clip[key]}`, previous = groups.get(group)
      if (previous !== undefined && previous !== clip.split) throw new Error(`split leakage: ${group}`)
      groups.set(group, clip.split)
    }
  }
}

/** 推定のフレーム支持区間だけを参照時計で照合。端点・欠測も真値分母に含める。 */
export function evaluateF0(reference: readonly F0[], estimated: readonly F0[], hop: number) {
  if (!(hop > 0) || !Number.isFinite(hop)) throw new Error('invalid F0 hop')
  for (const rows of [reference, estimated]) rows.forEach((f, i) => {
    if (!Number.isFinite(f.t) || f.t < 0 || (i > 0 && f.t <= rows[i - 1].t) ||
      (f.hz !== null && (!Number.isFinite(f.hz) || f.hz < 0))) throw new Error('invalid F0 sequence')
  })
  let cursor = 0, voiced = 0, unvoiced = 0, tp = 0, fp = 0, correct = 0, octave = 0
  const cents: number[] = []
  for (const target of reference) {
    while (cursor + 1 < estimated.length && Math.abs(estimated[cursor + 1].t - target.t) < Math.abs(estimated[cursor].t - target.t)) cursor++
    const nearest = estimated[cursor]
    const hz = nearest && Math.abs(nearest.t - target.t) <= hop / 2 + 1e-8 ? nearest.hz ?? 0 : 0
    if ((target.hz ?? 0) <= 0) { unvoiced++; if (hz > 0) fp++; continue }
    voiced++
    if (hz <= 0) continue
    tp++
    const error = 1200 * Math.log2(hz / target.hz!)
    cents.push(error)
    if (Math.abs(error) <= 50 + 1e-8) correct++
    const octaves = Math.round(error / 1200)
    if (octaves !== 0 && Math.abs(error - octaves * 1200) <= 50 + 1e-8) octave++
  }
  return { gtVoiced: voiced, gtUnvoiced: unvoiced, tp, fp, fn: voiced - tp, tn: unvoiced - fp,
    correct50: correct, octaveErrors: octave, voicedRecall: ratio(tp, voiced),
    unvoicedFalsePositive: ratio(fp, unvoiced), accuracy50: ratio(correct, voiced), octaveRate: ratio(octave, voiced),
    detectedOnlyCents: { signed: distribution(cents), absolute: distribution(cents.map(Math.abs)),
      bins: { within50: correct, from50To100: cents.filter(x => Math.abs(x) > 50 && Math.abs(x) <= 100).length,
        from100To600: cents.filter(x => Math.abs(x) > 100 && Math.abs(x) <= 600).length,
        over600: cents.filter(x => Math.abs(x) > 600).length } } }
}

/** 最大二部照合。返すペアは[正解index,推定index]で、カテゴリrecallも同じglobal対応を使う。 */
export function maximumMatching(referenceCount: number, estimatedCount: number,
  accepts: (r: number, e: number) => boolean): [number, number][] {
  const edges = Array.from({ length: estimatedCount }, (_, e) =>
    Array.from({ length: referenceCount }, (_, r) => r).filter(r => accepts(r, e)))
  const owners = new Array<number>(referenceCount).fill(-1)
  const augment = (e: number, seen: Set<number>): boolean => {
    for (const r of edges[e]) {
      if (seen.has(r)) continue
      seen.add(r)
      if (owners[r] === -1 || augment(owners[r], seen)) { owners[r] = e; return true }
    }
    return false
  }
  for (let e = 0; e < estimatedCount; e++) augment(e, new Set())
  return owners.flatMap((e, r) => e === -1 ? [] : [[r, e] as [number, number]])
}

/** 不正な注釈・推定を除外してスコアを上げず、明示的に失敗させる。連続音高を許す。 */
function checkNotes(notes: readonly Note[]): void {
  for (const n of notes) if (![n.start, n.end, n.midi].every(Number.isFinite) || n.start < 0 || n.end <= n.start || n.midi < 0 || n.midi > 127)
    throw new Error('invalid note interval/pitch')
}

/** 音高/onsetの標準照合とoffset付き照合を独立に最大化する。 */
export function evaluateNoteEvents(reference: readonly Note[], estimated: readonly Note[]) {
  checkNotes(reference); checkNotes(estimated)
  const pairs = (offset: boolean) => maximumMatching(reference.length, estimated.length, (r, e) => {
    const a = reference[r], b = estimated[e]
    return Math.abs(a.midi - b.midi) <= .5 + 1e-8 && Math.abs(a.start - b.start) <= .05 + 1e-8 &&
      (!offset || Math.abs(a.end - b.end) <= Math.max(.05, .2 * (a.end - a.start)) + 1e-8)
  })
  const onset = pairs(false), offset = pairs(true)
  return { onset: counts(onset.length, reference.length, estimated.length),
    offset: counts(offset.length, reference.length, estimated.length), onsetPairs: onset, offsetPairs: offset }
}

/** 有声/休符の占有時間をunionで数える。重複音符でcoverageが100%を超えない。 */
function coveredIntervals(start: number, end: number, notes: readonly Note[]): [number, number][] {
  const ordered = notes.map(n => [Math.max(start, n.start), Math.min(end, n.end)] as [number, number])
    .filter(([a, b]) => b > a).sort((a, b) => a[0] - b[0])
  const merged: [number, number][] = []
  for (const interval of ordered) {
    const last = merged.at(-1)
    if (last && interval[0] <= last[1] + 1e-8) last[1] = Math.max(last[1], interval[1])
    else merged.push([...interval])
  }
  return merged
}

/** 各正解音の正音coverage/最大欠落/分断とglobal matchを保存し、平均値に埋もれさせない。 */
export function noteDiagnostics(reference: readonly Note[], estimated: readonly Note[], duration: number) {
  const matches = evaluateNoteEvents(reference, estimated)
  const onsets = new Set(matches.onsetPairs.map(([r]) => r)), offsets = new Set(matches.offsetPairs.map(([r]) => r))
  const ordered = reference.map((note, index) => ({ note, index })).sort((a, b) => a.note.start - b.note.start)
  const details = ordered.map(({ note, index }, i) => {
    const candidates = estimated.filter(e => Math.abs(e.midi - note.midi) <= .5 + 1e-8)
    const intervals = coveredIntervals(note.start, note.end, candidates)
    let cursor = note.start, maximumGap = 0, covered = 0
    for (const [a, b] of intervals) { maximumGap = Math.max(maximumGap, a - cursor); covered += b - a; cursor = b }
    maximumGap = Math.max(maximumGap, note.end - cursor)
    const duration = note.end - note.start
    const previous = ordered[i - 1]?.note
    const reattack = previous !== undefined && Math.abs(previous.midi - note.midi) <= .5
    return { index, ...note, duration, onsetMatched: onsets.has(index), offsetMatched: offsets.has(index),
      coverage: covered / duration, maximumGap, fragments: intervals.length,
      overlappingAttacks: candidates.filter(e => e.start < note.end && e.end > note.start).length,
      long: duration >= 2 - 1e-8, short: duration <= .12 + 1e-8, reattack }
  })
  const categories = Object.fromEntries(['long', 'short', 'reattack'].map(key => {
    const selected = details.filter(n => n[key as 'long' | 'short' | 'reattack'])
    return [key, { count: selected.length, matched: selected.filter(n => n.onsetMatched).length,
      recall: ratio(selected.filter(n => n.onsetMatched).length, selected.length),
      offsetRecall: ratio(selected.filter(n => n.offsetMatched).length, selected.length),
      meanCoverage: ratio(selected.reduce((s, n) => s + n.coverage, 0), selected.length),
      gapsOver100ms: selected.filter(n => n.maximumGap > .1 + 1e-8).length,
      extraAttacks: selected.reduce((s, n) => s + Math.max(0, n.overlappingAttacks - 1), 0) }]
  }))
  const audible = coveredIntervals(0, duration, reference), rests: [number, number][] = []
  let cursor = 0
  for (const [a, b] of audible) { if (a > cursor) rests.push([cursor, a]); cursor = b }
  if (cursor < duration) rests.push([cursor, duration])
  const restSeconds = rests.reduce((s, [a, b]) => s + b - a, 0)
  const filledSeconds = rests.reduce((s, [a, b]) => s + coveredIntervals(a, b, estimated).reduce((sum, [x, y]) => sum + y - x, 0), 0)
  return { categories, rests: { count: rests.length, seconds: restSeconds, filledSeconds, falseOccupancy: ratio(filledSeconds, restSeconds) }, details }
}

/** Scoreの音高+重なり最大対応で量子化だけの消失/追加を測る。正しい拍の評価とは別。 */
export function scoreDiagnostics(performance: readonly Note[], score: readonly Note[], duration: number) {
  checkNotes(performance); checkNotes(score)
  const pairs = maximumMatching(performance.length, score.length, (r, e) =>
    Math.abs(performance[r].midi - score[e].midi) <= .5 &&
    Math.min(performance[r].end, score[e].end) > Math.max(performance[r].start, score[e].start))
  const matched = new Set(pairs.map(([r]) => r))
  const details = noteDiagnostics(performance, score, duration)
  return { lost: performance.length - pairs.length, added: score.length - pairs.length,
    lostIndices: performance.flatMap((_, i) => matched.has(i) ? [] : [i]), pairs,
    durationErrorSeconds: distribution(pairs.map(([r, e]) => (score[e].end - score[e].start) - (performance[r].end - performance[r].start))),
    falseRests: details.details.filter(n => n.maximumGap > 1e-8).length,
    falseRestSeconds: details.details.reduce((s, n) => s + n.duration * (1 - n.coverage), 0),
    filledReferenceRestSeconds: details.rests.filledSeconds,
    performanceReattacks: details.details.filter(n => n.reattack).length,
    scoreReattacks: score.filter((n, i) => i > 0 && n.midi === score[i - 1].midi).length }
}
