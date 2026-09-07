import test from 'node:test'
import assert from 'node:assert/strict'
import { analyze, PitchAnalyzer } from '../src/analysis/pipeline.ts'
import { detectYin } from '../src/analysis/detectors.ts'
import { buildNotes } from '../src/analysis/notes.ts'
import { variableGainVoice, shortOctaveVoice } from './fixtures/period-voice.ts'
import { evaluatePeriod } from './fixtures/evaluate-period.ts'

test('bounded continuity reduces gain-induced octave errors without claiming their complete removal', () => {
  for (const sr of [44100, 48000]) for (const mode of ['song', 'speech'] as const) {
    const pcm = variableGainVoice(sr)
    const strict = evaluatePeriod(pcm, sr, mode, false).filter(f => f.t > 0.45 && f.t < 1.45)
    const bounded = evaluatePeriod(pcm, sr, mode, true).filter(f => f.t > 0.45 && f.t < 1.45)
    const errors = (frames: typeof strict) => frames.filter(f => f.frequency && Math.abs(1200 * Math.log2(f.frequency / 150)) > 50).length
    assert.ok(errors(bounded) < errors(strict))
    assert.equal(bounded.filter(f => !f.frequency).length, strict.filter(f => !f.frequency).length)
    assert.ok(bounded.some(f => f.corrected))
    assert.ok(bounded.every((f, i) => !f.corrected || !bounded[i - 1]?.corrected))
  }
})

test('noisy weak fundamentals retain genuine 100 ms octave changes in both directions', () => {
  for (const sampleRate of [44100, 48000])
    for (const mode of ['song', 'speech'] as const)
      for (const direction of ['down', 'up'] as const)
        for (const noise of [0, 0.04, 0.1]) {
          const frames = analyze(shortOctaveVoice(sampleRate, 130, noise, direction), sampleRate, mode)
          const target = direction === 'down' ? 130 : 260
          const middle = frames.filter(f => f.t >= 0.8 && f.t < 0.9 && f.frequency && Math.abs(1200 * Math.log2(f.frequency / target)) < 25)
          assert.ok(middle.length >= 3, `${sampleRate} ${mode} ${direction} ${noise}`)
          const notes = buildNotes(frames, mode, 'continuous', 1.3)
          assert.ok(notes.some(n => n.start < 0.9 && n.end > 0.8 && n.end - n.start >= 0.03 - 1e-9 &&
            Math.abs(n.midi - (69 + 12 * Math.log2(target / 440))) < 0.25))
          assert.ok(frames.some(f => f.t >= 0.94 && f.t <= 1.05 && f.frequency &&
            Math.abs(1200 * Math.log2(f.frequency / (direction === 'down' ? 260 : 130))) < 25))
        }
})

test('history-dependent analysis is identical across arbitrary live chunk boundaries', () => {
  const pcm = variableGainVoice()
  for (const mode of ['song', 'speech'] as const) {
    const analyzer = new PitchAnalyzer(48000, mode)
    const live = []
    for (let i = 0; i < pcm.length; i += 127) live.push(...analyzer.push(pcm.subarray(i, i + 127)))
    live.push(...analyzer.finish())
    assert.deepEqual(live, analyze(pcm, 48000, mode))
  }
})

test('correlated noise cannot turn a weak-fundamental octave descent into a held overtone', () => {
  for (const sampleRate of [44100, 48000]) for (const mode of ['song', 'speech'] as const)
    for (const correlation of [0.8, 0.95]) for (const noise of [0.02, 0.04]) {
      const frames = analyze(shortOctaveVoice(sampleRate, 130, noise, 'down', 71, correlation), sampleRate, mode)
      const correct = frames.filter(f => f.t >= 0.83 && f.t <= 0.88 && f.frequency &&
        Math.abs(1200 * Math.log2(f.frequency / 130)) < 25)
      assert.ok(correct.length >= (mode === 'song' ? 3 : 5), `${sampleRate} ${mode} ${correlation} ${noise}`)
      const notes = buildNotes(frames, mode, 'continuous', 1.3)
      assert.ok(notes.some(n => n.start < 0.88 && n.end > 0.83 && n.end - n.start >= 0.03 - 1e-9 &&
        Math.abs(n.midi - (69 + 12 * Math.log2(130 / 440))) < 0.25))
    }
})

test('a timbre-changing 100 ms descent cannot be held at its preceding overtone', () => {
  for (const sr of [44100, 48000]) for (const mode of ['song', 'speech'] as const)
    for (const correlation of [0, 0.8, 0.95]) for (const noise of [0.02, 0.04]) {
      const frames = analyze(shortOctaveVoice(sr, 130, noise, 'down', 71, correlation, true), sr, mode)
      const notes = buildNotes(frames, mode, 'continuous', 1.3)
      assert.ok(notes.some(n => n.start < 0.9 && n.end > 0.8 && n.end - n.start >= 0.03 - 1e-9 &&
        Math.abs(n.midi - (69 + 12 * Math.log2(130 / 440))) < 0.25), `${sr} ${mode} ${correlation} ${noise}`)
    }
})

test('silence clears pitch context and a new segment starts from waveform evidence', () => {
  const pcm = shortOctaveVoice()
  pcm.fill(0, Math.round(48000 * 0.65), Math.round(48000 * 0.8))
  for (const mode of ['song', 'speech'] as const) {
    const frames = analyze(pcm, 48000, mode)
    const first = frames.find((f, i) => i && frames[i - 1].frequency === null && f.frequency && f.t > 0.8)!
    assert.ok(first)
    const window = Math.round(48000 * (mode === 'song' ? 0.08 : 0.06))
    const start = Math.round(first.t * 48000 - window / 2)
    assert.equal(first.frequency, detectYin(pcm.subarray(start, start + window), 48000).frequency)
  }
})

test('a contextual choice cannot authorize another correction or fabricate periodicity', () => {
  const pcm = shortOctaveVoice(48000, 130, 0.04, 'down', 71, 0, true)
  const window = pcm.subarray(Math.round(48000 * 0.81), Math.round(48000 * 0.89))
  const strict = detectYin(window, 48000)
  const first = detectYin(window, 48000, { frequency: 260, periodicity: 1 })
  assert.equal(first.usedContinuity, true)
  assert.ok(first.periodicity < strict.periodicity)
  assert.deepEqual(detectYin(window, 48000, first), strict)
  assert.equal(detectYin(new Float32Array(3840), 48000, first).frequency, null)
})

test('marginal speech candidates cannot shorten the remaining noisy low-note evidence', () => {
  for (const sr of [44100, 48000]) {
    const pcm = shortOctaveVoice(sr, 82.41, 0.1, 'down', 71, 0.8, true)
    const strict = evaluatePeriod(pcm, sr, 'speech', false)
    const bounded = evaluatePeriod(pcm, sr, 'speech', true)
    for (let i = 0; i < strict.length; i++) {
      const f = strict[i]
      if (f.t >= 0.8 && f.t < 0.9 && f.frequency && Math.abs(1200 * Math.log2(f.frequency / 82.41)) < 50)
        assert.equal(bounded[i].frequency, f.frequency)
    }
  }
})
