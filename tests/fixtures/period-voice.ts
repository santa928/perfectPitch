/** Deterministic monophonic carrier with cycle-to-cycle gain variation after a stable lead. */
export function variableGainVoice(sampleRate = 48000, hz = 150, seed = 93): Float32Array {
  const gains = Array.from({ length: Math.ceil(hz * 2) }, () => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0
    return 0.65 + 0.7 * seed / 2 ** 32
  })
  return Float32Array.from({ length: Math.round(sampleRate * 1.8) }, (_, i) => {
    const t = i / sampleRate
    if (t < 0.4 || t >= 1.5) return 0
    const phase = hz * t
    return 0.2 * Math.sin(2 * Math.PI * phase) * (t < 0.7 ? 1 : gains[Math.floor(phase)])
  })
}

/** A genuine 100 ms octave change with a weak fundamental, dominant second harmonic and seeded noise. */
export function shortOctaveVoice(
  sampleRate = 48000,
  lowHz = 130,
  noise = 0.04,
  direction: 'down' | 'up' = 'down',
  seed = 71,
  noiseCorrelation = 0,
  changeTimbre = false,
): Float32Array {
  let colored = 0
  return Float32Array.from({ length: Math.round(sampleRate * 1.3) }, (_, i) => {
    const t = i / sampleRate
    if (t < 0.4 || t >= 1.15) return 0
    const middle = t >= 0.8 && t < 0.9
    const hz = middle === (direction === 'down') ? lowHz : lowHz * 2
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0
    colored = noiseCorrelation * colored + Math.sqrt(1 - noiseCorrelation ** 2) * (seed / 2 ** 32 * 2 - 1)
    return changeTimbre && !middle
      ? 0.25 * Math.sin(2 * Math.PI * hz * t) + noise * colored
      : 0.025 * Math.sin(2 * Math.PI * hz * t) + 0.25 * Math.sin(4 * Math.PI * hz * t) + noise * colored
  })
}
