import test from 'node:test'
import assert from 'node:assert/strict'
import { analyze, PitchAnalyzer } from '../src/analysis/pipeline.ts'
import { buildNotes } from '../src/analysis/notes.ts'
import { detectYin, detectMpm } from '../src/analysis/detectors.ts'
const sr = 48000
/** Synthetic mono tone with an explicitly timed quiet calibration lead-in. */
function tone(hz: number, seconds = 0.8, lead = 0.35): Float32Array {
  return Float32Array.from({ length: Math.round(sr * seconds) }, (_, i) =>
    i < lead * sr ? 0 : 0.2 * Math.sin((2 * Math.PI * hz * i) / sr),
  )
}
test('YIN and MPM resolve low fundamentals and continuous cents', () => {
  for (const detect of [detectYin, detectMpm])
    for (const hz of [55, 82.41, 98, 220, 440, 1000, 440 * 2 ** (0.3 / 12)]) {
      const result = detect(tone(hz, 0.08, 0), sr)
      assert.ok(result.frequency !== null, String(hz))
      assert.ok(
        Math.abs(1200 * Math.log2(result.frequency! / hz)) < 20,
        `${hz}: ${result.frequency}`,
      )
    }
})
test('stream chunks and offline analysis have identical sample times and values', () => {
  const samples = tone(220)
  const analyzer = new PitchAnalyzer(sr, 'song')
  const frames = []
  for (let i = 0; i < samples.length; i += 127)
    frames.push(...analyzer.push(samples.subarray(i, i + 127)))
  frames.push(...analyzer.finish())
  assert.deepEqual(frames, analyze(samples, sr, 'song'))
  assert.ok(frames.some((frame) => frame.state === 'calibrating'))
  assert.ok(frames.filter((frame) => frame.state === 'voiced').length > 20)
})
test('zero input and seeded broadband noise do not become notes', () => {
  assert.ok(
    analyze(new Float32Array(sr), sr, 'song').every(
      (frame) => frame.frequency === null,
    ),
  )
  let seed = 51
  const noise = Float32Array.from({ length: sr }, () => {
    seed = (1664525 * seed + 1013904223) >>> 0
    return (seed / 2 ** 32 - 0.5) * 0.08
  })
  assert.ok(
    analyze(noise, sr, 'speech').every((frame) => frame.state !== 'voiced'),
  )
})
test('100ms notes, genuine octave jump and rests survive note conversion', () => {
  const frames = Array.from({ length: 50 }, (_, i) => ({
    t: i * 0.01,
    frequency: i < 10 || (i >= 30 && i < 40) ? 440 : i < 20 ? 880 : null,
    midi: i < 10 || (i >= 30 && i < 40) ? 69.3 : i < 20 ? 81.3 : null,
    rms: 0.1,
    periodicity: 0.99,
    state: (i < 20 || (i >= 30 && i < 40) ? 'voiced' : 'silence') as
      | 'voiced'
      | 'silence',
  }))
  const notes = buildNotes(frames, 'song', 'continuous', 0.5)
  assert.equal(notes.length, 3)
  assert.equal(notes[0].midi, 69.3)
  assert.ok(notes[0].end <= notes[1].start)
  assert.ok(notes[1].end < notes[2].start)
  assert.ok(notes.every((note) => note.end - note.start >= 0.08))
  assert.equal(buildNotes(frames, 'song', 'rounded', 0.5)[0].midi, 69)
})
test('isolated octave blip is corrected only in notes, raw frames remain unchanged', () => {
  const frames = Array.from({ length: 30 }, (_, i) => ({
    t: i * 0.01,
    frequency: i === 10 ? 880 : 440,
    midi: i === 10 ? 81 : 69,
    rms: 0.1,
    periodicity: 0.99,
    state: 'voiced' as const,
  }))
  assert.equal(buildNotes(frames, 'song', 'continuous', 0.3).length, 1)
  assert.equal(frames[10].midi, 81)
})
test('real PCM retains 100ms low tones without chopping and bounds jump latency', () => {
  for (const mode of ['song', 'speech'] as const) {
    const samples = Float32Array.from({ length: sr * 1.3 }, (_, i) => {
      const t = i / sr
      const hz =
        t >= 0.35 && t < 0.55
          ? 220
          : t >= 0.55 && t < 0.75
            ? 440
            : t >= 0.85 && t < 0.95
              ? 82.41
              : t >= 1.05 && t < 1.15
                ? 98
                : 0
      return hz ? 0.2 * Math.sin(2 * Math.PI * hz * t) : 0
    })
    const frames = analyze(samples, sr, mode)
    const notes = buildNotes(frames, mode, 'continuous', 1.3)
    assert.equal(notes.length, 4)
    assert.ok(notes[2].end < notes[3].start)
    assert.ok(notes[2].end - notes[2].start >= 0.05)
    assert.ok(notes[3].end - notes[3].start >= 0.05)
    assert.ok(
      frames.some(
        (frame) =>
          frame.t >= 0.55 &&
          frame.t <= 0.63 &&
          frame.frequency &&
          Math.abs(frame.frequency - 440) < 4,
      ),
    )
  }
})
test('continuous mode preserves vibrato and glides without repeated notes; rounded mode has hysteresis', () => {
  const frames = Array.from({ length: 100 }, (_, i) => ({
    t: i * 0.01,
    frequency: 440,
    midi: 69 + 0.3 * Math.sin(i * 0.3),
    rms: 0.1,
    periodicity: 0.99,
    state: 'voiced' as const,
  }))
  const continuous = buildNotes(frames, 'song', 'continuous', 1)
  assert.equal(continuous.length, 1)
  assert.ok(
    Math.max(...continuous[0].contour.map((point) => point.midi)) > 69.29,
  )
  assert.ok(
    Math.min(...continuous[0].contour.map((point) => point.midi)) < 68.71,
  )
  const rounded = buildNotes(
    frames.map((frame) => ({ ...frame, midi: frame.midi + 0.4 })),
    'song',
    'rounded',
    1,
  )
  assert.ok(rounded.length < 12)
})
