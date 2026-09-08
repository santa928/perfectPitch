import assert from 'node:assert/strict'
import { writeFileSync } from 'node:fs'
import { sustainedInput } from '../tests/fixtures/sustained-voice.ts'
import type { PitchFrame } from '../src/analysis/pipeline.ts'

const root = process.argv.includes('--baseline') ? 'file:///baseline/' : new URL('../', import.meta.url).href
const { PitchAnalyzer } = await import(`${root}src/analysis/pipeline.ts`)
const { buildNotes } = await import(`${root}src/analysis/notes.ts`)
const rows: object[] = []
for (const mode of ['song', 'speech']) for (const kind of ['silence', 'white', 'breath', 'consonant', 'hum']) {
  const sr = 16000, pcm = sustainedInput(sr, true, 3)
  let seed = 987, colored = 0
  for (let i = .3 * sr; i < pcm.length; i++) {
    const t = i / sr
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0
    const white = seed / 2 ** 32 * 2 - 1
    colored = .8 * colored + .2 * white
    pcm[i] = kind === 'silence' ? 0 : kind === 'white' ? .02 * white
      : kind === 'breath' ? .03 * colored * (.5 + .5 * Math.sin(2 * Math.PI * 1.3 * t))
      : kind === 'consonant' ? .1 * white * Math.exp(-30 * (t % .4))
      : .02 * Math.sin(2 * Math.PI * 60 * t) + .001 * white
  }
  for (const calibrate of [true, false]) {
    const frames: PitchFrame[] = new PitchAnalyzer(sr, mode, undefined, calibrate).push(pcm)
    const tail = frames.filter(f => f.t >= .5 && f.t <= 2.8)
    const voiced = tail.filter(f => f.frequency !== null).length
    rows.push({ mode, kind, calibrate, voiced, total: tail.length, notes: buildNotes(frames, mode, 'continuous', 3).length })
    // 周期的な環境音は声と同じ波形になり得る既知の限界。数字を隠さず別列にする。
    if (kind !== 'hum') assert.equal(voiced, 0, `${mode}/${kind}/${calibrate}`)
  }
}
const output = process.argv.includes('--baseline') ? 'output/sustained-noise-before.json' : 'output/sustained-noise-after.json'
writeFileSync(output, JSON.stringify(rows, null, 2) + '\n')
console.log(output)
