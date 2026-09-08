import { detectYin, type Detection, type YinCandidate } from './detectors.ts'
export type AnalysisMode = 'song' | 'speech'
export type PitchFrame = {
  t: number
  frequency: number | null
  midi: number | null
  rms: number
  periodicity: number
  state: 'voiced' | 'unvoiced' | 'uncertain' | 'silence' | 'calibrating'
  /** 一次判定の開発用記録。録音後の候補追跡/短窓再測定で最終Hzが変わっても保持する。 */
  initialGate?: {
    candidateHz: number | null
    candidatePeriodicity: number
    noiseFloor: number
    effectiveNoiseFloor: number
    requiredRms: number
    reason: 'periodic-recovery' | 'periodic' | 'calibration' | 'below-energy' | 'aperiodic' | 'ambiguous'
  }
}
export const ANALYSIS_SETTINGS = {
  song: { windowMs: 80, hopMs: 10, periodicity: 0.9 },
  speech: { windowMs: 60, hopMs: 10, periodicity: 0.85 },
} as const

/** PCM sample-clock analyzer shared by live/offline review; one window and one accepted estimate. */
export class PitchAnalyzer {
  private readonly sampleRate: number
  private readonly mode: AnalysisMode
  private readonly buffer: Float32Array
  private readonly hop: number
  private filled = 0
  private count = 0
  private noiseFloor = 0.001
  private quietRms: number[] = []
  private ended = false
  private previousDetection: Detection | null = null
  private readonly onEvidence?: (frame: PitchFrame, candidates: YinCandidate[]) => void
  private readonly calibrate: boolean

  /** マイクは最初の300msの非周期音で校正。有声の即発声は校正中も保持する。 */
  constructor(sampleRate: number, mode: AnalysisMode,
    onEvidence?: (frame: PitchFrame, candidates: YinCandidate[]) => void, calibrate = true) {
    if (
      !Number.isFinite(sampleRate) ||
      sampleRate < 8000 ||
      sampleRate > 192000
    )
      throw new Error('Unsupported sample rate')
    this.sampleRate = sampleRate
    this.mode = mode
    this.onEvidence = onEvidence
    this.calibrate = calibrate
    this.buffer = new Float32Array(
      Math.round((sampleRate * ANALYSIS_SETTINGS[mode].windowMs) / 1000),
    )
    this.hop = Math.round((sampleRate * ANALYSIS_SETTINGS[mode].hopMs) / 1000)
  }

  /** Consume samples once. Chunk boundaries and UI frame rate cannot change analysis times. */
  push(samples: Float32Array): PitchFrame[] {
    if (this.ended) throw new Error('Analyzer is finished')
    const frames: PitchFrame[] = []
    for (const sample of samples) {
      this.buffer[this.filled++] = Number.isFinite(sample) ? sample : 0
      this.count++
      if (this.filled !== this.buffer.length) continue
      frames.push(this.frame())
      this.buffer.copyWithin(0, this.hop)
      this.filled -= this.hop
    }
    return frames
  }

  /** End without fabricating samples; a remaining incomplete hop is not analyzed. */
  finish(): PitchFrame[] {
    this.ended = true
    return []
  }

  /** 現在の波形で判定する。強い周期信号を雑音学習せず、古い雑音量だけで棄却しない。 */
  private frame(): PitchFrame {
    let energy = 0
    for (const value of this.buffer) energy += value * value
    const rms = Math.sqrt(energy / this.buffer.length)
    let candidates: YinCandidate[] = []
    const detection =
      rms > 0.0001
        ? detectYin(this.buffer, this.sampleRate, this.previousDetection,
          this.onEvidence ? values => { candidates = values } : undefined)
        : { frequency: null, periodicity: 0 }
    const t = (this.count - this.buffer.length / 2) / this.sampleRate
    const noiseFloor = this.noiseFloor
    // CMNDFの不一致分を保守的な残差振幅として使う（雑音の実測値や確率ではない）。
    // 通常の有声閾値より強い根拠を要求し、前のHzや時間による補間は使わない。
    const clearPeriodic = detection.frequency !== null && detection.periodicity >= .97
    const effectiveNoiseFloor = clearPeriodic
      // 回復だけで未校正時のfloor .001より感度を上げない。静かな校正値はminで維持。
      ? Math.min(noiseFloor, Math.max(.001, rms * Math.sqrt(1 - detection.periodicity)))
      : noiseFloor
    const requiredRms = Math.max(.001, effectiveNoiseFloor * 2.8)
    const voiced = detection.frequency !== null &&
      detection.periodicity >= ANALYSIS_SETTINGS[this.mode].periodicity && rms >= requiredRms
    let state: PitchFrame['state']
    let reason: NonNullable<PitchFrame['initialGate']>['reason']
    if (this.calibrate && this.count / this.sampleRate <= 0.3 && !voiced) {
      state = 'calibrating'
      reason = 'calibration'
      if (detection.periodicity < 0.6) {
        this.quietRms.push(rms)
        const ordered = [...this.quietRms].sort((a, b) => a - b)
        this.noiseFloor = Math.max(
          0.0003,
          ordered[Math.floor(ordered.length * 0.25)],
        )
      }
    } else if (voiced) {
      state = 'voiced'
      reason = rms < noiseFloor * 2.8 ? 'periodic-recovery' : 'periodic'
    } else if (rms < .001 || (detection.periodicity < .6 && rms < noiseFloor * 1.6)) {
      state = 'silence'
      reason = 'below-energy'
    } else if (detection.periodicity < .6) {
      state = 'unvoiced'
      reason = 'aperiodic'
    } else {
      state = 'uncertain'
      reason = 'ambiguous'
    }
    if (state === 'silence' && detection.periodicity < .6)
      this.noiseFloor = Math.max(0.0003, this.noiseFloor * 0.995 + rms * 0.005)
    const frequency = state === 'voiced' ? detection.frequency : null
    // Only consecutive accepted frames provide context; never bridge gaps or recordings.
    this.previousDetection = frequency === null ? null : detection
    const frame: PitchFrame = {
      t,
      frequency,
      midi: frequency === null ? null : 69 + 12 * Math.log2(frequency / 440),
      rms,
      periodicity: detection.periodicity,
      state,
      initialGate: { candidateHz: detection.frequency, candidatePeriodicity: detection.periodicity,
        noiseFloor, effectiveNoiseFloor, requiredRms, reason },
    }
    this.onEvidence?.(frame, candidates)
    return frame
  }
}

/** Reanalyze original PCM with exactly the live detector and sample clock. */
export function analyze(
  samples: Float32Array,
  sampleRate: number,
  mode: AnalysisMode,
): PitchFrame[] {
  const analyzer = new PitchAnalyzer(sampleRate, mode)
  return [...analyzer.push(samples), ...analyzer.finish()]
}
