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
    noiseFloorAfter: number
    backgroundFloor: number
    effectiveNoiseFloor: number
    requiredRms: number
    /** floor更新を支持した連続候補列の開始時刻。offlineの同区間再判定に使う。 */
    recoveryStart?: number
    reason: 'noise-floor-recovery' | 'periodic-recovery' | 'periodic' | 'calibration' | 'below-energy' | 'aperiodic' | 'ambiguous'
  }
  /** 同じPCMの連続候補でfloor回復を確認後、一次棄却を見直した根拠。 */
  voicingReview?: { source: 'confirmed-noise-floor'; noiseFloor: number; supportStart: number; supportEnd: number }
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
  /** 周期信号による回復を含まない、低周期性PCMだけから得た基準。 */
  private backgroundFloor = 0.001
  private quietRms: number[] = []
  private recoveryEvidence: { t: number; frequency: number; residual: number; clear: boolean }[] = []
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

  /**
   * 連続100ms・音高幅100c以内、うち30ms以上の強い周期候補で校正値を更新する。
   * 採用済みstateを根拠にせず、最大残差を使って小さく見積もりすぎない。
   * 非周期音・微小音・急な音高変化で支持を破棄し、休符をまたいで蓄積しない。
   */
  private recoverNoiseFloor(detection: Detection, rms: number, t: number): number | undefined {
    if (detection.frequency === null || detection.periodicity < .9 || rms < .0028) {
      this.recoveryEvidence = []
      return undefined
    }
    const evidence = { t, frequency: detection.frequency,
      clear: detection.periodicity >= .97,
      residual: Math.max(.001, rms * Math.sqrt(1 - detection.periodicity)) }
    const frequencies = [...this.recoveryEvidence.map(item => item.frequency), evidence.frequency]
    if (1200 * Math.log2(Math.max(...frequencies) / Math.min(...frequencies)) > 100)
      this.recoveryEvidence = []
    this.recoveryEvidence.push(evidence)
    const required = Math.ceil(.1 * this.sampleRate / this.hop) + 1
    if (this.recoveryEvidence.length > required) this.recoveryEvidence.shift()
    if (this.recoveryEvidence.length < required) return undefined
    if (this.recoveryEvidence.filter(item => item.clear).length < Math.ceil(.03 * this.sampleRate / this.hop) + 1)
      return undefined
    const estimate = Math.max(...this.recoveryEvidence.map(item => item.residual))
    if (estimate >= this.noiseFloor) return undefined
    this.noiseFloor = estimate
    return this.recoveryEvidence[0].t
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
    const recoveryStart = this.recoverNoiseFloor(detection, rms, t)
    // CMNDFの不一致分を保守的な残差振幅として使う（雑音の実測値や確率ではない）。
    // 通常の有声閾値より強い根拠を要求し、前のHzや時間による補間は使わない。
    const clearPeriodic = detection.frequency !== null && detection.periodicity >= .97
    const effectiveNoiseFloor = clearPeriodic
      // 回復だけで未校正時のfloor .001より感度を上げない。静かな校正値はminで維持。
      ? Math.min(this.noiseFloor, Math.max(.001, rms * Math.sqrt(1 - detection.periodicity)))
      // 回復を支持できない低周期性の環境音には、回復前の雑音基準を維持する。
      : detection.periodicity >= .9 ? this.noiseFloor : this.backgroundFloor
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
        this.backgroundFloor = this.noiseFloor
      }
    } else if (voiced) {
      state = 'voiced'
      reason = recoveryStart !== undefined ? 'noise-floor-recovery'
        : rms < this.noiseFloor * 2.8 ? 'periodic-recovery' : 'periodic'
    } else if (rms < .001 || (detection.periodicity < .6 && rms < effectiveNoiseFloor * 1.6)) {
      state = 'silence'
      reason = 'below-energy'
    } else if (detection.periodicity < .6) {
      state = 'unvoiced'
      reason = 'aperiodic'
    } else {
      state = 'uncertain'
      reason = 'ambiguous'
    }
    if (state === 'silence' && detection.periodicity < .6) {
      this.noiseFloor = Math.max(0.0003, this.noiseFloor * 0.995 + rms * 0.005)
      this.backgroundFloor = Math.max(0.0003, this.backgroundFloor * 0.995 + rms * 0.005)
    }
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
        noiseFloor, noiseFloorAfter: this.noiseFloor, backgroundFloor: this.backgroundFloor,
        effectiveNoiseFloor, requiredRms, reason,
        ...(recoveryStart === undefined ? {} : { recoveryStart }) },
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
