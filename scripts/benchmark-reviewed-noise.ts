import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync } from 'node:fs'
import { sustainedNoise } from '../tests/fixtures/sustained-noise.ts'
import type { PitchFrame } from '../src/analysis/pipeline.ts'

// --baselineはレビュー対象6b55ff9の変更していない元ソースを直接importする。
const baseline = process.argv.includes('--baseline')
const root = baseline ? 'file:///baseline/' : new URL('../', import.meta.url).href
const { PitchAnalyzer } = await import(`${root}src/analysis/pipeline.ts`)
const { analyzeOffline } = await import(`${root}src/analysis/offline.ts`)
const { buildNotes } = await import(`${root}src/analysis/notes.ts`)
const results: object[] = []
mkdirSync('output', { recursive: true })
for (const sr of [16000, 44100, 48000]) {
  for (const scenario of ['ongoing', 'uncalibrated', 'quiet-lead', 'later-noise', 'weak-onset']) {
    const pcm = sustainedNoise(sr, scenario === 'later-noise' ? 2 : scenario === 'weak-onset' ? .3 : .8,
      scenario === 'quiet-lead', scenario !== 'weak-onset')
    const original = pcm.slice(), calibrate = scenario !== 'uncalibrated'
    for (const path of ['live', 'offline']) {
      const start = performance.now()
      const frames: PitchFrame[] = path === 'live'
        ? new PitchAnalyzer(sr, 'song', undefined, calibrate).push(pcm)
        : analyzeOffline(pcm, sr, 'song', undefined, calibrate)
      const elapsedMs = performance.now() - start
      const tail = frames.filter(f => f.t >= (scenario === 'later-noise' ? 2.2 : 1) && f.t <= 5.8)
      const correct = tail.filter(f => f.frequency !== null && Math.abs(1200 * Math.log2(f.frequency / 220)) < 50).length
      const updates = frames.filter(f => f.initialGate?.recoveryStart !== undefined)
      results.push({ sr, scenario, path, samples: pcm.length, elapsedMs, correct, total: tail.length,
        lastFrame: frames.at(-1)?.t, lastVoiced: frames.findLast(f => f.frequency !== null)?.t,
        noteEnd: buildNotes(frames, 'song', 'continuous', 6).at(-1)?.end,
        floorUpdates: updates.length, firstUpdate: updates[0]?.t,
        offlineReviewed: frames.filter(f => f.voicingReview !== undefined).length,
        atOnset: frames.find(f => f.t === .4), at5: frames.find(f => f.t === 5) })
      assert.deepEqual(pcm, original)
      if (!baseline && scenario !== 'weak-onset') {
        assert.ok(correct / tail.length >= .95, `${sr}/${scenario}/${path}`)
        assert.equal(frames.at(-1)?.t, 5.96)
        assert.ok(buildNotes(frames, 'song', 'continuous', 6).at(-1)!.end >= 5.95)
      }
    }
  }
}
const output = `output/reviewed-noise-${baseline ? 'before' : 'after'}.json`
writeFileSync(output, JSON.stringify({ node: process.version, platform: `${process.platform}/${process.arch}`,
  baselineSha: '6b55ff93b6e70974ca96c1d58dd1a082b5831f70', results }, null, 2) + '\n')
console.log(output)
