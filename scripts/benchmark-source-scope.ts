import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync } from 'node:fs'
import { sourceTransition } from '../tests/fixtures/source-transitions.ts'
import type { PitchFrame } from '../src/analysis/pipeline.ts'

// --baselineは470c21cの未変更srcをread-only mountし、同じPCMで直接実行する。
const baseline = process.argv.includes('--baseline')
const root = baseline ? 'file:///baseline/' : new URL('../', import.meta.url).href
const { PitchAnalyzer } = await import(`${root}src/analysis/pipeline.ts`)
const { analyzeOffline } = await import(`${root}src/analysis/offline.ts`)
const { buildNotes } = await import(`${root}src/analysis/notes.ts`)
const results: object[] = []
for (const sr of [16000, 44100, 48000]) {
  for (const kind of ['background', 'noisy-jump', 'restart'] as const) {
    const rest = kind === 'restart' ? .4 : 0
    const pcm = sourceTransition(sr, 173, kind === 'background' ? .008 : .02, rest,
      kind === 'noisy-jump' ? .1 : 2, kind === 'background' ? .003 : .005)
    const original = pcm.slice()
    for (const path of ['live', 'offline']) {
      const start = performance.now()
      const frames: PitchFrame[] = path === 'live' ? new PitchAnalyzer(sr, 'speech').push(pcm)
        : analyzeOffline(pcm, sr, 'speech')
      const elapsedMs = performance.now() - start
      const region = frames.filter(f => f.t >= (kind === 'noisy-jump' ? 1 : 1.2 + rest) &&
        f.t <= (kind === 'noisy-jump' ? 1.1 : 2.8))
      const voiced = region.filter(f => f.frequency !== null).length
      const correct = region.filter(f => f.frequency !== null && Math.abs(1200 * Math.log2(f.frequency / 173)) < 50).length
      const notes = buildNotes(frames, 'speech', 'continuous', 3)
      const jumps = notes.filter(n => Math.abs(n.midi - (69 + 12 * Math.log2(173 / 440))) < .5)
      results.push({ sr, kind, path, elapsedMs, samples: pcm.length, total: region.length, voiced, correct,
        lastFrame: frames.at(-1)?.t, lastVoiced: frames.findLast(f => f.frequency !== null)?.t,
        newNoteDurations: jumps.map(n => n.end - n.start),
        transitions: frames.filter(f => f.initialGate?.recoveryKind === 'level-continuous-transition'),
        atBoundary: frames.find(f => f.t === 1.2), atEnd: frames.at(-1) })
      assert.deepEqual(pcm, original)
      if (!baseline) {
        if (kind === 'background') assert.equal(voiced, 0)
        else if (kind === 'noisy-jump') {
          assert.ok(correct >= 3)
          assert.ok(jumps.some(n => n.end - n.start >= .03))
        } else assert.ok(correct / region.length >= .95)
      }
    }
  }
}
mkdirSync('output', { recursive: true })
const output = `output/source-scope-${baseline ? 'before' : 'after'}.json`
writeFileSync(output, JSON.stringify({ baselineSha: '470c21cdf6d38a9c7e6f535a0a66d6b64b9036e8',
  node: process.version, platform: `${process.platform}/${process.arch}`, results }, null, 2) + '\n')
console.log(output)
