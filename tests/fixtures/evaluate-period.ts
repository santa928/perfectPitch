import { performance } from 'node:perf_hooks'
import { detectYin, type Detection } from '../../src/analysis/detectors.ts'
import { ANALYSIS_SETTINGS, type AnalysisMode } from '../../src/analysis/pipeline.ts'

/** Synthetic sequence harness with known quiet calibration; the real adaptive noise floor is tested separately. */
export function evaluatePeriod(pcm: Float32Array, sr: number, mode: AnalysisMode, contextual: boolean) {
  const settings = ANALYSIS_SETTINGS[mode]
  const size = Math.round(sr * settings.windowMs / 1000), hop = Math.round(sr * 0.01)
  let previous: Detection | null = null
  const frames = []
  for (let start = 0; start + size <= pcm.length; start += hop) {
    const input = pcm.subarray(start, start + size)
    const rms = Math.sqrt(input.reduce((sum, value) => sum + value * value, 0) / size)
    const begin = performance.now()
    const detection = rms > 0.0001 ? detectYin(input, sr, contextual ? previous : null) : { frequency: null, periodicity: 0 }
    const ms = performance.now() - begin
    const frequency = (start + size) / sr > 0.3 && rms >= 0.001 && detection.periodicity >= settings.periodicity ? detection.frequency : null
    previous = frequency === null ? null : detection
    frames.push({ t: (start + size / 2) / sr, frequency, ms, corrected: !!detection.usedContinuity })
  }
  return frames
}
