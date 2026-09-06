/** PR #15時点のYINを比較用に保存。出典: d2b48d5/src/analysis/detectors.ts。 */
export type Detection = { frequency: number | null; periodicity: number }
const MIN_HZ = 55
const MAX_HZ = 1000

/** Remove DC once so lag comparisons do not confuse microphone bias with periodicity. */
function centered(input: Float32Array): Float32Array {
  let mean = 0
  for (const value of input) mean += value
  mean /= input.length || 1
  return input.map((value) => value - mean)
}

/** Parabolic extremum interpolation retains sub-sample lag precision. */
function interpolate(values: Float64Array, index: number): number {
  const a = values[index - 1],
    b = values[index],
    c = values[index + 1]
  const denominator = a - 2 * b + c
  return (
    index +
    (denominator && Number.isFinite(denominator)
      ? Math.max(-1, Math.min(1, (a - c) / (2 * denominator)))
      : 0)
  )
}

/** Apply the declared frequency range after interpolation, allowing endpoint roundoff. */
function result(
  lag: number,
  sampleRate: number,
  periodicity: number,
): Detection {
  const hz = sampleRate / lag
  return {
    frequency:
      hz >= MIN_HZ * 0.997 && hz <= MAX_HZ * 1.003
        ? Math.max(MIN_HZ, Math.min(MAX_HZ, hz))
        : null,
    periodicity: Math.max(0, Math.min(1, periodicity)),
  }
}

/** YIN fixed-support squared difference, CMNDF threshold 0.15 and parabolic refinement. */
export function detectYin(input: Float32Array, sampleRate: number): Detection {
  const data = centered(input)
  const maxLag = Math.min(
    Math.ceil(sampleRate / MIN_HZ) + 1,
    Math.floor(data.length / 2) - 1,
  )
  const minLag = Math.max(2, Math.floor(sampleRate / MAX_HZ) - 1)
  if (maxLag <= minLag) return { frequency: null, periodicity: 0 }
  const support = data.length - maxLag
  const normalized = new Float64Array(maxLag + 1)
  normalized[0] = 1
  let sum = 0
  for (let lag = 1; lag <= maxLag; lag++) {
    let difference = 0
    for (let i = 0; i < support; i++) {
      const delta = data[i] - data[i + lag]
      difference += delta * delta
    }
    sum += difference
    normalized[lag] = sum > 1e-15 ? (difference * lag) / sum : 1
  }
  let best = minLag
  for (let lag = minLag; lag < maxLag; lag++) {
    if (normalized[lag] < normalized[best]) best = lag
    if (normalized[lag] < 0.15) {
      while (lag + 1 < maxLag && normalized[lag + 1] < normalized[lag]) lag++
      return result(
        interpolate(normalized, lag),
        sampleRate,
        1 - normalized[lag],
      )
    }
  }
  return { frequency: null, periodicity: Math.max(0, 1 - normalized[best]) }
}
