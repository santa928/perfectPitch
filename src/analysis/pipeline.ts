import { detectYin, type Detection } from './detectors.ts'
export type AnalysisMode = 'song' | 'speech'
export type PitchFrame = {
  t: number
  frequency: number | null
  midi: number | null
  rms: number
  periodicity: number
  state: 'voiced' | 'unvoiced' | 'uncertain' | 'silence' | 'calibrating'
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

  /** Configure a fresh recording. Calibration occupies the first 300 ms of PCM. */
  constructor(sampleRate: number, mode: AnalysisMode) {
    if (
      !Number.isFinite(sampleRate) ||
      sampleRate < 8000 ||
      sampleRate > 192000
    )
      throw new Error('Unsupported sample rate')
    this.sampleRate = sampleRate
    this.mode = mode
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

  /** Estimate raw pitch, classify energy/periodicity, and freeze the noise floor during voiced input. */
  private frame(): PitchFrame {
    let energy = 0
    for (const value of this.buffer) energy += value * value
    const rms = Math.sqrt(energy / this.buffer.length)
    const detection =
      rms > 0.0001
        ? detectYin(this.buffer, this.sampleRate, this.previousDetection)
        : { frequency: null, periodicity: 0 }
    const t = (this.count - this.buffer.length / 2) / this.sampleRate
    let state: PitchFrame['state']
    if (this.count / this.sampleRate <= 0.3) {
      state = 'calibrating'
      if (detection.periodicity < 0.6) {
        this.quietRms.push(rms)
        const ordered = [...this.quietRms].sort((a, b) => a - b)
        this.noiseFloor = Math.max(
          0.0003,
          ordered[Math.floor(ordered.length * 0.25)],
        )
      }
    } else if (rms < Math.max(0.001, this.noiseFloor * 1.6)) state = 'silence'
    else if (
      detection.frequency !== null &&
      detection.periodicity >= ANALYSIS_SETTINGS[this.mode].periodicity &&
      rms >= this.noiseFloor * 2.8
    )
      state = 'voiced'
    else if (detection.periodicity < 0.6) state = 'unvoiced'
    else state = 'uncertain'
    if (state === 'silence')
      this.noiseFloor = Math.max(0.0003, this.noiseFloor * 0.995 + rms * 0.005)
    const frequency = state === 'voiced' ? detection.frequency : null
    // Only consecutive accepted frames provide context; never bridge gaps or recordings.
    this.previousDetection = frequency === null ? null : detection
    return {
      t,
      frequency,
      midi: frequency === null ? null : 69 + 12 * Math.log2(frequency / 440),
      rms,
      periodicity: detection.periodicity,
      state,
    }
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
