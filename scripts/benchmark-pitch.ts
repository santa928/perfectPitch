import { performance } from 'node:perf_hooks'
import { writeFileSync } from 'node:fs'
import { autoCorrelate } from '../tests/fixtures/legacy-detector.ts'
import { detectYin, detectMpm } from '../src/analysis/detectors.ts'
import { analyze, ANALYSIS_SETTINGS } from '../src/analysis/pipeline.ts'
import { buildNotes } from '../src/analysis/notes.ts'
const detectors = {
  legacy: (x: Float32Array, sr: number) => {
    const result = autoCorrelate(x, sr)
    return { frequency: result.frequency, periodicity: result.confidence }
  },
  yin: detectYin,
  mpm: detectMpm,
}
/** Deterministic synthetic source: exact frequency labels and no downloaded voice data. */
function tone(
  hz: number,
  sr: number,
  ms: number,
  amplitude: number,
  phase: number,
  harmonics: number[],
): Float32Array {
  return Float32Array.from(
    { length: Math.round((sr * ms) / 1000) },
    (_, i) =>
      (amplitude *
        harmonics.reduce(
          (sum, weight, h) =>
            sum +
            weight * Math.sin((2 * Math.PI * hz * (h + 1) * i) / sr + phase),
          0,
        )) /
      harmonics.reduce((a, b) => a + b),
  )
}
/** Nearest-rank quantile; errors only include returned voiced estimates. */
function quantile(values: number[], p: number): number | null {
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[Math.max(0, Math.ceil(sorted.length * p) - 1)] ?? null
}
let seed = 93
/** Fixed-seed broadband noise, reset once per benchmark for reproducibility. */
function random(): number {
  seed = (1664525 * seed + 1013904223) >>> 0
  return (seed / 2 ** 32) * 2 - 1
}
const rows = []
const failures = []
for (const windowMs of [40, 60, 80]) {
  const signals = []
  for (const sr of [44100, 48000])
    for (const base of [55, 82.41, 98, 220, 440, 1000])
      for (const cents of [-30, 0, 30]) {
        const hz = base * 2 ** (cents / 1200)
        if (hz < 55 || hz > 1000) continue
        for (const amplitude of [0.01, 0.25])
          for (const phase of [0, 1.3])
            for (const harmonics of [[1], [1, 0.5, 0.25], [0.3, 1, 0.4]])
              signals.push({
                sr,
                hz,
                base,
                cents,
                amplitude,
                phase,
                harmonics,
                data: tone(hz, sr, windowMs, amplitude, phase, harmonics),
              })
      }
  const nonperiodic = []
  for (const sr of [44100, 48000])
    for (let n = 0; n < 32; n++) {
      let previous = 0
      nonperiodic.push({
        sr,
        data: Float32Array.from(
          { length: Math.round((sr * windowMs) / 1000) },
          () =>
            n < 8
              ? 0
              : n < 20
                ? random() * 0.02
                : (previous = previous * 0.85 + random() * 0.01),
        ),
      })
    }
  for (const [name, detect] of Object.entries(detectors)) {
    for (let warm = 0; warm < 10; warm++) detect(signals[0].data, signals[0].sr)
    const errors: number[] = [],
      times: number[] = []
    let misses = 0,
      gross = 0,
      octaves = 0,
      falseVoiced = 0
    for (const signal of signals) {
      const start = performance.now()
      const result = detect(signal.data, signal.sr)
      times.push(performance.now() - start)
      if (result.frequency === null) {
        misses++
        failures.push({
          detector: name,
          windowMs,
          ...signal,
          data: undefined,
          reason: 'miss',
        })
        continue
      }
      const error = Math.abs(1200 * Math.log2(result.frequency / signal.hz))
      errors.push(error)
      if (error > 50) {
        gross++
        if (Math.abs(error - 1200) < 50) octaves++
        failures.push({
          detector: name,
          windowMs,
          ...signal,
          data: undefined,
          estimated: result.frequency,
          centsError: error,
        })
      }
    }
    for (const signal of nonperiodic)
      if (detect(signal.data, signal.sr).frequency !== null) falseVoiced++
    rows.push({
      detector: name,
      windowMs,
      voicedCases: signals.length,
      negativeCases: nonperiodic.length,
      medianCents: quantile(errors, 0.5),
      p95Cents: quantile(errors, 0.95),
      missRate: misses / signals.length,
      grossOver50CentsRate: gross / signals.length,
      octaveRate: octaves / signals.length,
      falseVoicedRate: falseVoiced / nonperiodic.length,
      p95Ms: quantile(times, 0.95),
    })
  }
}
const noisyRows = []
for (const windowMs of [40, 60, 80])
  for (const snrDb of [10, 20]) {
    const signals = []
    for (const sr of [44100, 48000])
      for (const hz of [55, 82.41, 98, 220, 440, 1000])
        for (const phase of [0, 1.3]) {
          const data = tone(hz, sr, windowMs, 0.2, phase, [1, 0.5, 0.25])
          const energy =
            data.reduce((sum, sample) => sum + sample * sample, 0) / data.length
          const noiseAmplitude = Math.sqrt(3 * energy) / 10 ** (snrDb / 20)
          for (let i = 0; i < data.length; i++)
            data[i] += random() * noiseAmplitude
          signals.push({ sr, hz, data })
        }
    for (const [name, detect] of Object.entries(detectors)) {
      const errors: number[] = []
      let misses = 0,
        gross = 0
      for (const signal of signals) {
        const result = detect(signal.data, signal.sr)
        if (result.frequency === null) {
          misses++
          continue
        }
        const error = Math.abs(1200 * Math.log2(result.frequency / signal.hz))
        errors.push(error)
        if (error > 50) gross++
      }
      noisyRows.push({
        detector: name,
        windowMs,
        snrDb,
        voicedCases: signals.length,
        medianCents: quantile(errors, 0.5),
        p95Cents: quantile(errors, 0.95),
        missRate: misses / signals.length,
        grossOver50CentsRate: gross / signals.length,
      })
    }
  }
const transitions = []
for (const mode of ['song', 'speech'] as const)
  for (const sr of [44100, 48000]) {
    const boundaries = [
      { start: 0.35, end: 0.55, hz: 220 },
      { start: 0.55, end: 0.75, hz: 440 },
      { start: 0.85, end: 0.95, hz: 82.41 },
      { start: 1.05, end: 1.15, hz: 98 },
    ]
    const samples = Float32Array.from(
      { length: Math.round(sr * 1.3) },
      (_, i) => {
        const segment = boundaries.find(
          (s) => i / sr >= s.start && i / sr < s.end,
        )
        return segment ? 0.2 * Math.sin((2 * Math.PI * segment.hz * i) / sr) : 0
      },
    )
    const frames = analyze(samples, sr, mode)
    const notes = buildNotes(frames, mode, 'continuous', 1.3)
    transitions.push({
      mode,
      sr,
      notes,
      events: boundaries.map((segment) => {
        const first = frames.find(
          (f) =>
            f.t >= segment.start - ANALYSIS_SETTINGS[mode].windowMs / 2000 &&
            f.t < segment.end &&
            f.frequency &&
            Math.abs(1200 * Math.log2(f.frequency / segment.hz)) < 50,
        )
        return {
          ...segment,
          firstCorrectFrameCenter: first?.t ?? null,
          causalLatencyMs: first
            ? (first.t +
                ANALYSIS_SETTINGS[mode].windowMs / 2000 -
                segment.start) *
              1000
            : null,
          retained: notes.some(
            (note) =>
              note.start < segment.end &&
              note.end > segment.start &&
              Math.abs(note.midi - (69 + 12 * Math.log2(segment.hz / 440))) <
                0.5,
          ),
        }
      }),
    })
  }
const output = {
  date: new Date().toISOString(),
  environment: {
    node: process.version,
    architecture: process.arch,
    platform: process.platform,
  },
  method:
    'All detectors receive identical unwindowed, phase-controlled PCM. Detector-only scores use returned frequency (no pipeline energy gating). Timing is warmed per detector/window; single process Docker CPU, not mobile hardware. Seeds=93; threshold fixed before comparison. Gross and octave denominator is all voiced cases; cents quantiles exclude misses. Causal latency includes right half of analysis window.',
  rows,
  noisyRows,
  transitions,
  failures,
}
writeFileSync(
  'docs/evaluation/synthetic-results.json',
  JSON.stringify(output, null, 2) + '\n',
)
console.table(rows)
console.table(noisyRows)
console.log(
  JSON.stringify(
    transitions.map((t) => ({
      mode: t.mode,
      sr: t.sr,
      events: t.events,
      noteCount: t.notes.length,
    })),
    null,
    2,
  ),
)
