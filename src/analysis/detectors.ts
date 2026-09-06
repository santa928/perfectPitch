/** Detector estimates are unrounded; periodicity is a signal score, not a probability. */
export type Detection = {
  frequency: number | null
  periodicity: number
  /** Context-assisted estimates cannot authorize another consecutive correction. */
  usedContinuity?: boolean
}
const MIN_HZ = 55
const MAX_HZ = 1000

/** Prefer an evidenced neighboring period only for an ambiguous downward octave switch. */
function continuousCandidate(
  normalized: Float64Array,
  best: number,
  minLag: number,
  primaryLag: number,
  sampleRate: number,
  previous: Detection | null,
): Detection {
  const primary = result(
    interpolate(normalized, primaryLag), sampleRate, 1 - normalized[primaryLag],
  )
  if (
    !primary.frequency || !previous?.frequency || previous.usedContinuity ||
    !Number.isFinite(previous.frequency) ||
    Math.abs(1200 * Math.log2(previous.frequency / primary.frequency) - 1200) >= 100
  ) return primary

  // An override needs >=0.9 periodicity even in speech mode. A marginal noisy
  // candidate must not displace the ordinary estimate just because it is nearby.
  const mismatch = normalized[best]
  const limit = Math.min(0.1, mismatch * 4 + 0.01)
  for (let lag = minLag; lag < primaryLag; lag++) {
    if (
      normalized[lag] >= limit || normalized[lag] > normalized[lag - 1] ||
      normalized[lag] > normalized[lag + 1]
    ) continue
    const candidate = result(interpolate(normalized, lag), sampleRate, 1 - normalized[lag])
    if (
      candidate.frequency &&
      Math.abs(1200 * Math.log2(candidate.frequency / previous.frequency)) < 100 &&
      Math.abs(1200 * Math.log2(candidate.frequency / primary.frequency) - 1200) < 60
    ) return { ...candidate, usedContinuity: true }
  }
  return primary
}

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

/**
 * YIN固定支持区間のCMNDF。最良の谷に近い最短周期を選び、弱い倍音候補への即決を避ける。
 * 通常は最良値との差0.01を要求する。直前の未補正の有声音高がある場合だけ、
 * 下方オクターブの競合を1フレーム判定する。補正した候補を次の補正の根拠にしない。
 */
export function detectYin(
  input: Float32Array,
  sampleRate: number,
  previous: Detection | null = null,
): Detection {
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
  for (let lag = minLag + 1; lag < maxLag; lag++)
    if (normalized[lag] < normalized[best]) best = lag
  const limit = Math.min(0.15, normalized[best] + 0.01)
  for (let lag = minLag; lag < maxLag; lag++) {
    if (
      normalized[lag] < limit &&
      normalized[lag] <= normalized[lag - 1] &&
      normalized[lag] <= normalized[lag + 1]
    ) {
      return continuousCandidate(normalized, best, minLag, lag, sampleRate, previous)
    }
  }
  return { frequency: null, periodicity: Math.max(0, 1 - normalized[best]) }
}

/** MPM normalized square difference and first strong positive-lobe peak (90% of maximum). */
export function detectMpm(input: Float32Array, sampleRate: number): Detection {
  const data = centered(input)
  const maxLag = Math.min(Math.ceil(sampleRate / MIN_HZ) + 2, data.length - 2)
  const minLag = Math.max(2, Math.floor(sampleRate / MAX_HZ) - 1)
  if (maxLag <= minLag) return { frequency: null, periodicity: 0 }
  const nsdf = new Float64Array(maxLag + 1)
  for (let lag = 0; lag <= maxLag; lag++) {
    let correlation = 0,
      energy = 0
    for (let i = 0; i < data.length - lag; i++) {
      const a = data[i],
        b = data[i + lag]
      correlation += a * b
      energy += a * a + b * b
    }
    nsdf[lag] = energy > 1e-15 ? (2 * correlation) / energy : 0
  }
  const peaks: number[] = []
  let crossedZero = false
  for (let lag = 1; lag < maxLag; lag++) {
    if (nsdf[lag] <= 0) crossedZero = true
    if (
      crossedZero &&
      lag >= minLag &&
      nsdf[lag] > 0 &&
      nsdf[lag] >= nsdf[lag - 1] &&
      nsdf[lag] > nsdf[lag + 1]
    )
      peaks.push(lag)
  }
  const highest = Math.max(0, ...peaks.map((lag) => nsdf[lag]))
  const selected = peaks.find(
    (lag) => nsdf[lag] >= Math.max(0.85, highest * 0.9),
  )
  return selected === undefined
    ? { frequency: null, periodicity: highest }
    : result(interpolate(nsdf, selected), sampleRate, nsdf[selected])
}
