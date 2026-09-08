import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync } from 'node:fs'
import { sustainedInput } from '../tests/fixtures/sustained-voice.ts'
import type { PitchFrame } from '../src/analysis/pipeline.ts'

// 比較元も元ファイルを直接importする。ソースの抽出/複製/書き換えはしない。
const root = process.argv.includes('--baseline') ? 'file:///baseline/' : new URL('../', import.meta.url).href
const { PitchAnalyzer } = await import(`${root}src/analysis/pipeline.ts`)
const { analyzeOffline } = await import(`${root}src/analysis/offline.ts`)
const { detectYin } = await import(`${root}src/analysis/detectors.ts`)
const { buildNotes } = await import(`${root}src/analysis/notes.ts`)
const { extractMelody } = await import(`${root}src/analysis/melody.ts`)
const results: object[] = []
mkdirSync('output', { recursive: true })
for (const sr of [16000, 44100, 48000]) for (const noise of [false, true]) for (const calibrate of [false, true]) {
  const pcm = sustainedInput(sr, noise)
  const analyzer = new PitchAnalyzer(sr, 'song', undefined, calibrate)
  const start = performance.now()
  const frames: PitchFrame[] = [...analyzer.push(pcm), ...analyzer.finish()]
  const tail = frames.filter(f => f.t >= 1 && f.t <= 5.8)
  const correct = tail.filter(f => f.frequency && Math.abs(1200 * Math.log2(f.frequency / 220)) < 50).length
  const sample = frames.find(f => f.t === 5)!
  const raw = detectYin(pcm.subarray(Math.round(4.96 * sr), Math.round(5.04 * sr)), sr)
  results.push({ sr, noise, calibrate, samples: pcm.length, duration: pcm.length / sr,
    correct, total: tail.length, lastVoiced: frames.findLast(f => f.frequency)?.t,
    lastFrame: frames.at(-1)?.t, liveMs: performance.now() - start,
    sample: { ...sample, raw, noiseFloorAfterInput: analyzer.noiseFloor } })
  if (!process.argv.includes('--baseline')) assert.ok(correct / tail.length >= .99)
}
for (const seconds of [6, 10, 30, 60]) {
  const sr = 48000, pcm = sustainedInput(sr, true, seconds), original = pcm.slice()
  const start = performance.now(), frames: PitchFrame[] = analyzeOffline(pcm, sr, 'song')
  const offlineMs = performance.now() - start
  const notes = buildNotes(frames, 'song', 'continuous', seconds), melody = extractMelody(frames, seconds)
  results.push({ seconds, sr, samples: pcm.length, frames: frames.length, offlineMs,
    lastFrame: frames.at(-1)?.t, lastVoiced: frames.findLast(f => f.frequency)?.t,
    noteEnd: notes.at(-1)?.end, melodyEnd: melody.at(-1)?.end })
  assert.deepEqual(pcm, original)
  if (!process.argv.includes('--baseline')) {
    assert.ok(frames.findLast(f => f.frequency)!.t >= seconds - .05)
    assert.ok(notes.at(-1)!.end >= seconds - .05)
    assert.ok(melody.at(-1)!.end >= seconds - .05)
    assert.ok(offlineMs < 60000, '既存Worker timeout以内')
  }
}
const output = process.argv.includes('--baseline') ? 'output/sustained-before.json' : 'output/sustained-after.json'
writeFileSync(output, JSON.stringify({ node: process.version, platform: `${process.platform}/${process.arch}`, results }, null, 2) + '\n')
console.log(output)
