/** レビュー5140352157の固定PCM。全sampleでseedを進め、導入だけを対照変更できる。 */
export function sustainedNoise(sr: number, noiseStart = .8, quietLead = false, loudLead = true, seconds = 6): Float32Array {
  let seed = 1
  return Float32Array.from({ length: seconds * sr }, (_, i) => {
    const t = i / sr
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0
    const white = seed / 4294967296 * 2 - 1
    if (t < .3) return quietLead ? 0 : .05 * white
    return (loudLead && t < .8 ? .16 : .02) * Math.sin(2 * Math.PI * 220 * t)
      + (t >= noiseStart ? .005 * white : 0)
  })
}
