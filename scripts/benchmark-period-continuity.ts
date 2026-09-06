import { writeFileSync } from 'node:fs'
import { variableGainVoice, shortOctaveVoice } from '../tests/fixtures/period-voice.ts'
import { evaluatePeriod as evaluate } from '../tests/fixtures/evaluate-period.ts'

const rows = []
for (const sr of [44100, 48000]) for (const mode of ['song', 'speech'] as const) {
  for (const hz of [110, 150, 220, 440]) for (const seed of [31, 93, 177]) {
    const pcm = variableGainVoice(sr, hz, seed)
    for (const contextual of [false, true]) {
      const frames = evaluate(pcm, sr, mode, contextual).filter(f => f.t > 0.45 && f.t < 1.45)
      const times = frames.map(f => f.ms).sort((a, b) => a - b)
      rows.push({ kind: 'gain', sr, mode, hz, seed, contextual, frames: frames.length,
        missing: frames.filter(f => f.frequency === null).length,
        gross: frames.filter(f => f.frequency && Math.abs(1200 * Math.log2(f.frequency / hz)) > 50).length,
        p95Ms: times[Math.ceil(times.length * 0.95) - 1] })
    }
  }
  for (const hz of [82.41, 130, 220, 440]) for (const noise of [0, 0.04, 0.1])
    for (const direction of ['down', 'up'] as const) for (const correlation of (noise === 0 ? [0] : [0, 0.8, 0.95]))
      for (const changeTimbre of (direction === 'down' ? [false, true] : [false])) {
      const pcm = shortOctaveVoice(sr, hz, noise, direction, 71, correlation, changeTimbre)
      const target = direction === 'down' ? hz : hz * 2
      for (const contextual of [false, true]) {
        const frames = evaluate(pcm, sr, mode, contextual)
        const middle = frames.filter(f => f.t >= 0.84 && f.t <= 0.86)
        let run = 0, longest = 0
        for (const frame of frames.filter(f => f.t >= 0.8 && f.t < 0.9)) {
          run = frame.frequency && Math.abs(1200 * Math.log2(frame.frequency / target)) < 50 ? run + 1 : 0
          longest = Math.max(longest, run)
        }
        rows.push({ kind: 'octave', sr, mode, hz, noise, correlation, direction, changeTimbre, contextual, frames: middle.length,
          missing: middle.filter(f => f.frequency === null).length,
          gross: middle.filter(f => f.frequency && Math.abs(1200 * Math.log2(f.frequency / target)) > 50).length,
          correctRunMs: longest * 10,
        })
      }
    }
}
const totals = []
for (const kind of ['gain', 'octave']) for (const mode of ['song', 'speech']) for (const contextual of [false, true]) {
  const selected = rows.filter(r => r.kind === kind && r.mode === mode && r.contextual === contextual)
  totals.push({ kind, mode, contextual, cases: selected.length,
    frames: selected.reduce((sum, r) => sum + r.frames, 0),
    missing: selected.reduce((sum, r) => sum + r.missing, 0),
    gross: selected.reduce((sum, r) => sum + r.gross, 0),
    no30msPitchRun: selected.filter(r => 'correctRunMs' in r && r.correctRunMs < 30).length,
  })
}
writeFileSync(process.argv[2] ?? 'docs/evaluation/period-continuity-results.json', JSON.stringify({
  date: new Date().toISOString(), environment: { node: process.version, arch: process.arch, platform: process.platform },
  method: 'Seeded synthetic carrier/gain variation and 100ms weak-fundamental octave changes, white/AR(1) noise and optional timbre change. Strict=no hint (PR16); contextual=bounded one-frame hint. Identical PCM and 80/60ms windows, 10ms hop, production periodicity thresholds. Harness assumes quiet calibration and fixed 0.001 energy floor; not a replacement for pipeline/browser tests. Gross>50c; misses excluded from gross but reported separately. Middle error uses 0.84-0.86s centers. correctRunMs counts consecutive correct centers during 0.8-0.9s, not final piano-note retention; actual note retention is tested separately. Tuning/regression cases, not held-out accuracy. Timing is Docker CPU, not real-device latency.',
  totals, rows,
}, null, 2) + '\n')
console.table(totals)
