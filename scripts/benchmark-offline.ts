import { writeFileSync } from 'node:fs'
import { analyze, type AnalysisMode, type PitchFrame } from '../src/analysis/pipeline.ts'
import { analyzeOffline } from '../src/analysis/offline.ts'
import { variableGainVoice, shortOctaveVoice } from '../tests/fixtures/period-voice.ts'

/** Report misses separately and measure the longest evidenced run in the known short note. */
function measure(frames: PitchFrame[], target: number, kind: string) {
  const selected = frames.filter(f => kind === 'gain' ? f.t > .45 && f.t < 1.45 : f.t >= .84 && f.t <= .86)
  let run = 0, longest = 0
  for (const f of frames.filter(f => f.t >= .8 && f.t < .9)) {
    run = f.frequency && Math.abs(1200 * Math.log2(f.frequency / target)) < 50 ? run + 1 : 0
    longest = Math.max(longest, run)
  }
  return { frames: selected.length, missing: selected.filter(f => !f.frequency).length,
    gross: selected.filter(f => f.frequency && Math.abs(1200 * Math.log2(f.frequency / target)) > 50).length,
    correctRunMs: longest * 10 }
}

const rows: object[] = []
/** Compare the real calibrated pipelines on identical PCM, including measured total processing time. */
function compare(pcm: Float32Array, sr: number, mode: AnalysisMode, target: number, description: { kind: string; [key: string]: unknown }): void {
  const began = performance.now(), live = analyze(pcm, sr, mode), middle = performance.now()
  const offline = analyzeOffline(pcm, sr, mode), ended = performance.now()
  rows.push({ ...description, sr, mode, live: { ...measure(live, target, description.kind), ms: middle - began },
    offline: { ...measure(offline, target, description.kind), ms: ended - middle } })
}

for (const sr of [44100, 48000]) for (const mode of ['song', 'speech'] as const) {
  for (const hz of [110, 150, 220, 440]) for (const seed of [31, 93, 177])
    compare(variableGainVoice(sr, hz, seed), sr, mode, hz, { kind: 'gain', hz, seed })
  for (const hz of [82.41, 130, 220, 440]) for (const noise of [0, .04, .1])
    for (const direction of ['down', 'up'] as const) for (const correlation of noise === 0 ? [0] : [0, .8, .95])
      for (const changeTimbre of direction === 'down' ? [false, true] : [false])
        compare(shortOctaveVoice(sr, hz, noise, direction, 71, correlation, changeTimbre), sr, mode,
          direction === 'down' ? hz : hz * 2, { kind: 'octave', hz, noise, direction, correlation, changeTimbre })
  console.log(`${sr}/${mode}: ${rows.length} comparisons`)
  writeFileSync(process.argv[2] ?? 'docs/evaluation/offline-results.json', JSON.stringify({
    environment: { node: process.version, arch: process.arch, platform: process.platform },
    method: 'Real calibrated pipelines; live=PR17 baseline; offline=future candidate tracking and evidenced gap recovery. Gross >50c excludes misses. Short-note central 0.84–0.86s and consecutive correct centers in 0.8–0.9s. Tuning/regression set, not held-out real-world accuracy. Processing time excludes microphone/browser I/O.',
    rows,
  }, null, 2) + '\n')
}
