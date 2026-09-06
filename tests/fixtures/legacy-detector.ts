/* Exact detector from main b67b836; constants and type copied unchanged. */
type PitchResult = { frequency: number | null; confidence: number }
const MIN_FREQUENCY = 55
const MAX_FREQUENCY = 1000
export const autoCorrelate = (
  buffer: Float32Array,
  sampleRate: number,
): PitchResult => {
  const size = buffer.length
  let mean = 0
  for (let i = 0; i < size; i += 1) {
    mean += buffer[i]
  }
  mean /= size

  let variance = 0
  for (let i = 0; i < size; i += 1) {
    const value = buffer[i] - mean
    variance += value * value
  }

  if (variance < 1e-7) {
    return { frequency: null, confidence: 0 }
  }

  const minLag = Math.max(1, Math.floor(sampleRate / MAX_FREQUENCY))
  const maxLag = Math.min(size - 1, Math.floor(sampleRate / MIN_FREQUENCY))

  let bestLag = -1
  let bestCorrelation = 0

  for (let lag = minLag; lag <= maxLag; lag += 1) {
    let correlation = 0
    for (let i = 0; i < size - lag; i += 1) {
      const a = buffer[i] - mean
      const b = buffer[i + lag] - mean
      correlation += a * b
    }

    if (correlation > bestCorrelation) {
      bestCorrelation = correlation
      bestLag = lag
    }
  }

  const confidence = Math.min(Math.max(bestCorrelation / variance, 0), 1)

  if (bestLag <= 0) {
    return { frequency: null, confidence }
  }

  return { frequency: sampleRate / bestLag, confidence }
}
