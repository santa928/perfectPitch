import { detectYin } from '../../src/analysis/detectors.ts'
import { ANALYSIS_SETTINGS } from '../../src/analysis/pipeline.ts'
import type { PianoNote } from '../../src/analysis/notes.ts'

interface BoundaryEvidence { index: number; side: 'start' | 'end'; from: number; to: number; hz: number; periodicity: number }

/**
 * 既存音符の外側40msだけを40ms PCM窓で再測定する候補。音符追加/削除/音高変更はしない。
 * 近傍音符を越えず、全プローブで独立した周期性・音高・局所音量を要求する。
 * 原F0の無声を有声へ書き換えず、演奏音符の境界だけを派生生成する。
 */
export function refineMelodyBoundaries(samples: Float32Array, sampleRate: number, input: readonly PianoNote[]) {
  const notes = input.map(n => ({ ...n, contour: n.contour.map(p => ({ ...p })) }))
  const evidence: BoundaryEvidence[] = []
  const size = Math.round(sampleRate * .04), localSize = Math.round(sampleRate * .01)
  const duration = samples.length / sampleRate
  /** 切り出し範囲をゼロ埋めせず、局所エネルギーを原PCMで測る。 */
  const rmsAt = (t: number): number => {
    const first = Math.round(t * sampleRate - localSize / 2)
    if (first < 0 || first + localSize > samples.length) return 0
    let energy = 0
    for (let i = first; i < first + localSize; i++) energy += samples[i] ** 2
    return Math.sqrt(energy / localSize)
  }
  for (let index = 0; index < input.length; index++) {
    const original = input[index], output = notes[index]
    for (const side of ['start', 'end'] as const) {
      const direction = side === 'start' ? -1 : 1
      // 最初/最後の解析窓の欠けは発声境界の観測ではない。録音の外側を推測しない。
      const edge = ANALYSIS_SETTINGS.song.windowMs / 2000
      if (original[side] < edge || original[side] > duration - edge) continue
      const inner = original[side] - direction * Math.min(.02, (original.end - original.start) / 2)
      const level = Math.max(.0028, rmsAt(inner) * .35)
      const limit = side === 'start' ? (notes[index - 1]?.end ?? edge) : (input[index + 1]?.start ?? duration - edge)
      for (let step = 1; step <= 4; step++) {
        const t = original[side] + direction * .01 * step
        if ((side === 'start' ? t < limit : t > limit) || rmsAt(t) < level) break
        const first = Math.round(t * sampleRate - size / 2)
        if (first < 0 || first + size > samples.length) break
        const candidate = detectYin(samples.subarray(first, first + size), sampleRate)
        if (candidate.frequency === null || candidate.periodicity < .95 ||
          Math.abs(69 + 12 * Math.log2(candidate.frequency / 440) - original.midi) > .5) break
        output[side] = t
        evidence.push({ index, side, from: original[side], to: t, hz: candidate.frequency, periodicity: candidate.periodicity })
      }
    }
    if (output.start !== original.start || output.end !== original.end)
      output.contour = [{ t: output.start, midi: output.midi }]
  }
  return { notes, evidence }
}
