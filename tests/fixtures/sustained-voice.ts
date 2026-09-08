/** Issue #20の固定seed・PCM。導入、レート、録音長だけを変えた対照にも使う。 */
export function sustainedInput(sr: number, noise = true, seconds = 6): Float32Array {
  let seed = 1
  return Float32Array.from({ length: seconds * sr }, (_, i) => {
    const t = i / sr
    if (t < .3) {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0
      return noise ? (seed / 4294967296 * 2 - 1) * .05 : 0
    }
    return (t < .8 ? .16 : .02) * Math.sin(2 * Math.PI * 220 * t)
  })
}
