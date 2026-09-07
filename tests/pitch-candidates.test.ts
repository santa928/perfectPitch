import test from 'node:test'
import assert from 'node:assert/strict'
import { detectYin } from '../src/analysis/detectors.ts'
import { buildNotes } from '../src/analysis/notes.ts'
import type { PitchFrame } from '../src/analysis/pipeline.ts'
import { analyze } from '../src/analysis/pipeline.ts'

/** 短い急落と本物の低音を、同じ前後の声に挟んで比較する。 */
function lowExcursion(count: number, drop: number): PitchFrame[] {
  return Array.from({ length: 40 + count }, (_, i) => {
    const midi = 60.2 - (i >= 20 && i < 20 + count ? drop : 0)
    return { t: i * .01, midi, frequency: 440 * 2 ** ((midi - 69) / 12), rms: .1, periodicity: .99, state: 'voiced' }
  })
}

test('すぐ同じ声へ戻る10–20msの大きな急落をピアノへ発音しない', () => {
  for (const count of [1, 2]) for (const drop of [12, 19, 24, 27]) {
    const frames = lowExcursion(count, drop)
    const before = structuredClone(frames)
    for (const mode of ['song', 'speech'] as const) for (const pitchMode of ['continuous', 'rounded'] as const) {
      const notes = buildNotes(frames, mode, pitchMode, 1)
      assert.equal(notes.length, 1, `${count * 10}ms / ${drop} semitones / ${mode} / ${pitchMode}`)
      assert.ok(notes[0].contour.every(point => point.midi >= 60))
    }
    assert.deepEqual(frames, before)
  }
})

test('続く低音・短い小さな音程変化・休符を挟む低音は残す', () => {
  for (const [count, drop] of [[3, 12], [4, 19], [6, 12], [10, 19], [2, 3]]) {
    const notes = buildNotes(lowExcursion(count, drop), 'speech', 'continuous', 1)
    assert.equal(notes.length, 3)
    assert.ok(Math.abs(notes[1].midi - (60.2 - drop)) < .001)
  }
  const frames = lowExcursion(4, 19)
  frames[19] = { ...frames[19], midi: null, frequency: null, state: 'unvoiced' }
  const notes = buildNotes(frames, 'speech', 'continuous', 1)
  assert.ok(notes.some(note => note.midi < 42))
  assert.ok(notes[1].start > notes[0].end)
})

/** 弱い基音と強い第2倍音で、最初の谷だけを選ぶオクターブ誤りを再現する。 */
function dominantSecond(hz: number, rate: number, phase: number, fundamental: number): Float32Array {
  return Float32Array.from({ length: Math.round(rate * .08) }, (_, i) => {
    const angle = 2 * Math.PI * hz * i / rate + phase
    return fundamental * Math.sin(angle) + .2 * Math.sin(2 * angle)
  })
}

test('強い第2倍音の弱い周期候補より、基音の明確な周期を選ぶ', () => {
  for (const rate of [44100, 48000]) for (const hz of [55, 110, 130, 220, 440]) for (const phase of [0, .7, 2]) for (const fundamental of [.02, .05]) {
    const detection = detectYin(dominantSecond(hz, rate, phase, fundamental), rate)
    assert.ok(detection.frequency !== null)
    assert.ok(Math.abs(1200 * Math.log2(detection.frequency / hz)) < 20, `${rate}Hz ${hz}Hz phase=${phase}: ${detection.frequency}`)
  }
})

/** 無声で挟まれた短い孤立判定と、持続する発声内の短い音程変化を区別する。 */
function framesWithIslands(): PitchFrame[] {
  return Array.from({ length: 70 }, (_, i) => {
    const voiced = (i >= 10 && i < 12) || (i >= 20 && i < 30) || (i >= 40 && i < 60)
    const midi = i >= 50 && i < 52 ? 72 : 69
    return { t: i * .01, frequency: voiced ? 440 : null, midi: voiced ? midi : null, rms: .1, periodicity: .98, state: voiced ? 'voiced' : 'unvoiced' }
  })
}

test('20msの孤立した有声判定を発音せず、100ms音と持続声内の短い跳躍は残す', () => {
  const frames = framesWithIslands()
  const before = structuredClone(frames)
  const notes = buildNotes(frames, 'speech', 'rounded', .7)
  assert.equal(notes.length, 4)
  assert.ok(notes[0].start >= .19)
  assert.ok(notes[0].end - notes[0].start >= .09)
  assert.ok(notes.some(note => note.midi === 72))
  assert.ok(notes[0].end < notes[1].start)
  assert.deepEqual(frames, before)
})

test('弱い基音の開始・終端で倍音へ分裂せず、休符と本物の跳躍を残す', () => {
  const rate = 48000
  const samples = Float32Array.from({ length: rate * 4 }, (_, i) => {
    const t = i / rate, hz = t < 2 ? 130 : 260
    return t < .5 || (t > 1.5 && t < 1.8) || t > 3.5
      ? 0 : .025 * Math.sin(2 * Math.PI * hz * t) + .25 * Math.sin(4 * Math.PI * hz * t)
  })
  for (const mode of ['song', 'speech'] as const) {
    const frames = analyze(samples, rate, mode)
    for (const pitchMode of ['continuous', 'rounded'] as const) {
      const notes = buildNotes(frames, mode, pitchMode, 4)
      assert.deepEqual(notes.map(note => Math.round(note.midi)), [48, 48, 60])
      assert.ok(notes[1].start - notes[0].end > .2)
      assert.ok(Math.abs(notes[2].start - 2) < .06)
    }
  }
})

test('境界補正は100msの実音・短い低音・内部の短い跳躍を変えない', () => {
  for (const pitches of [
    [...Array(10).fill(72), ...Array(20).fill(60), ...Array(10).fill(72)],
    [...Array(3).fill(48), ...Array(20).fill(60), ...Array(3).fill(48)],
    [...Array(20).fill(60), ...Array(3).fill(72), ...Array(20).fill(60)],
  ]) {
    const frames: PitchFrame[] = pitches.map((midi: number, i: number) => ({ t: .4 + i * .01, midi, frequency: 440 * 2 ** ((midi - 69) / 12), rms: .1, periodicity: .99, state: 'voiced' }))
    const before = structuredClone(frames)
    const notes = buildNotes(frames, 'song', 'rounded', 2)
    assert.equal(notes.length, 3)
    assert.deepEqual(notes.map(note => note.midi), [pitches[0], pitches[Math.floor(pitches.length / 2)], pitches.at(-1)])
    assert.deepEqual(frames, before)
  }
})

test('明示的な10msの無声判定を同音間でも埋めない', () => {
  const frames: PitchFrame[] = Array.from({ length: 41 }, (_, i) => ({
    t: i * .01, midi: i === 20 ? null : 60, frequency: i === 20 ? null : 261.63,
    rms: i === 20 ? 0 : .1, periodicity: i === 20 ? 0 : .99,
    state: i === 20 ? 'silence' : 'voiced',
  }))
  for (const mode of ['song', 'speech'] as const) {
    const notes = buildNotes(frames, mode, 'rounded', .41)
    assert.equal(notes.length, 2)
    assert.ok(Math.abs(notes[1].start - notes[0].end - .01) < 1e-9)
  }
})
