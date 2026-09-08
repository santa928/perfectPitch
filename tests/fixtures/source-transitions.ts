/** 同じ初期雑音・先行発声に対し、後続音源の高さ/音量/休符だけを変えた対照PCM。 */
export function sourceTransition(sr: number, hz: number, gain: number, rest = 0, jumpSeconds = 2, targetNoise = .003): Float32Array {
  let seed = 923, phase = 0
  return Float32Array.from({ length: sr * 3 }, (_, i) => {
    const t = i / sr, changed = t >= 1 + rest && t < 1 + rest + jumpSeconds
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0
    const white = seed / 2 ** 32 * 2 - 1
    phase += 2 * Math.PI * (changed ? hz : 220) / sr
    if (t < .3) return .05 * white
    if (t >= 1 && t < 1 + rest) return .003 * white
    return (changed ? gain : .02) * Math.sin(phase) + (changed ? targetNoise : .003) * white
  })
}
