/** 評価専用の秒単位の音符。本番解析器への正解入力として使わない。 */
export interface ReferenceNote { start: number; end: number; midi: number }

/** 1対1照合の集計値。 */
export interface NoteMetrics {
  matched: number; precision: number; recall: number; f1: number
  falsePositives: number; falseNegatives: number
}

/** 発音・終了時刻と音高列を別々に比較した結果。 */
export interface NoteEvaluation {
  onset: NoteMetrics
  onsetOffset: NoteMetrics
  pitchSequence: {
    editDistance: number; normalizedEditDistance: number
    referenceLength: number; estimatedLength: number
  }
}

/** 通常BPM誤差と倍半分を許した参考値を混同しない結果。 */
export interface TempoEvaluation {
  absoluteError: number
  relativeError: number
  octaveReference: {
    referenceMultiplier: number; comparisonBpm: number
    absoluteError: number; relativeError: number
  }
}

/** 異常な区間を拒否し、原配列を変更せず発音順へ並べる。 */
function chronological(notes: readonly ReferenceNote[]): ReferenceNote[] {
  for (const { start, end, midi } of notes) {
    if (!Number.isFinite(start) || !Number.isFinite(end) || start < 0 || end <= start
      || !Number.isInteger(midi) || midi < 0 || midi > 127)
      throw new RangeError('評価音符には非負の有限時刻、正の音長、整数MIDI 0–127が必要です')
  }
  return [...notes].sort((a, b) => a.start - b.start)
}

/** 増加路で最大の1対1照合を求め、同じ正解の使い回しを防ぐ。 */
function matchNotes(
  reference: readonly ReferenceNote[], estimated: readonly ReferenceNote[], withOffset: boolean,
): NoteMetrics {
  const edges = estimated.map((candidate) => reference.flatMap((target, index) => {
    const onsetMatches = candidate.midi === target.midi
      && Math.abs(candidate.start - target.start) <= 0.1 + 1e-9
    const offsetTolerance = Math.max(0.1, (target.end - target.start) * 0.2)
    return onsetMatches && (!withOffset
      || Math.abs(candidate.end - target.end) <= offsetTolerance + 1e-9) ? [index] : []
  }))
  const owners = new Array<number>(reference.length).fill(-1)
  /** 先に割り当てた音符を移せる場合も含め、一つの対応先を確保する。 */
  const augment = (candidate: number, visited: Set<number>): boolean => {
    for (const target of edges[candidate]) {
      if (visited.has(target)) continue
      visited.add(target)
      if (owners[target] === -1 || augment(owners[target], visited)) {
        owners[target] = candidate
        return true
      }
    }
    return false
  }
  let matched = 0
  for (let index = 0; index < estimated.length; index++)
    if (augment(index, new Set())) matched++
  const total = reference.length + estimated.length
  return {
    matched,
    precision: estimated.length ? matched / estimated.length : 1,
    recall: reference.length ? matched / reference.length : 1,
    f1: total ? 2 * matched / total : 1,
    falsePositives: estimated.length - matched,
    falseNegatives: reference.length - matched,
  }
}

/** 発音順のMIDI列について挿入・削除・置換各1のLevenshtein距離を求める。 */
function sequenceDistance(reference: readonly ReferenceNote[], estimated: readonly ReferenceNote[]): number {
  let previous = Array.from({ length: estimated.length + 1 }, (_, i) => i)
  for (let r = 1; r <= reference.length; r++) {
    const current = [r]
    for (let e = 1; e <= estimated.length; e++) {
      current[e] = Math.min(previous[e] + 1, current[e - 1] + 1,
        previous[e - 1] + (reference[r - 1].midi === estimated[e - 1].midi ? 0 : 1))
    }
    previous = current
  }
  return previous[estimated.length]
}

/** 移調・時刻補正なしで、音高+発音と音高+発音+終了の最大1対1照合を別集計する。 */
export function evaluateNotes(
  reference: readonly ReferenceNote[], estimated: readonly ReferenceNote[],
): NoteEvaluation {
  const targets = chronological(reference)
  const candidates = chronological(estimated)
  const editDistance = sequenceDistance(targets, candidates)
  return {
    onset: matchNotes(targets, candidates, false),
    onsetOffset: matchNotes(targets, candidates, true),
    pitchSequence: {
      editDistance,
      normalizedEditDistance: editDistance / Math.max(1, targets.length),
      referenceLength: targets.length,
      estimatedLength: candidates.length,
    },
  }
}

/** 正解BPMを基準に通常誤差と、正解の0.5/1/2倍を比較した参考値を返す。 */
export function evaluateTempo(referenceBpm: number, estimatedBpm: number): TempoEvaluation {
  if (![referenceBpm, estimatedBpm].every((bpm) => Number.isFinite(bpm) && bpm > 0))
    throw new RangeError('評価BPMには正の有限値が必要です')
  const absoluteError = Math.abs(estimatedBpm - referenceBpm)
  const relativeError = absoluteError / referenceBpm
  if (!Number.isFinite(relativeError)) throw new RangeError('BPM比率が計算可能な範囲を超えています')
  const octaveReference = [1, 0.5, 2].map((referenceMultiplier) => {
    const comparisonBpm = referenceBpm * referenceMultiplier
    const error = Math.abs(estimatedBpm - comparisonBpm)
    return { referenceMultiplier, comparisonBpm, absoluteError: error, relativeError: error / comparisonBpm }
  }).filter((candidate) => Number.isFinite(candidate.relativeError))
    .sort((a, b) => a.relativeError - b.relativeError)[0]
  return { absoluteError, relativeError, octaveReference }
}
