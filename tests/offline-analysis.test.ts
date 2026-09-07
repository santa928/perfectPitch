import assert from 'node:assert/strict'
import test from 'node:test'
import { analyze } from '../src/analysis/pipeline.ts'
import { analyzeOffline } from '../src/analysis/offline.ts'
import { buildNotes } from '../src/analysis/notes.ts'
import { variableGainVoice, shortOctaveVoice } from './fixtures/period-voice.ts'

/** Count known-pitch errors without treating missing detections as correct. */
function errors(frames: ReturnType<typeof analyze>, hz: number): number {
  return frames.filter(f => f.t > .45 && f.t < 1.45 &&
    (!f.frequency || Math.abs(1200 * Math.log2(f.frequency / hz)) > 50)).length
}

test('offline evidence reduces changing-period gain errors while retaining sample times and PCM', () => {
  const pcm = variableGainVoice(), original = pcm.slice()
  const live = analyze(pcm, 48000, 'song'), offline = analyzeOffline(pcm, 48000, 'song')
  assert.ok(errors(offline, 150) < errors(live, 150))
  assert.deepEqual(offline.map(f => f.t), live.map(f => f.t))
  assert.deepEqual(pcm, original)
})

test('offline tracking retains genuine short octave changes with weak fundamentals and changing timbre', () => {
  for (const mode of ['song', 'speech'] as const) for (const direction of ['up', 'down'] as const) {
    const pcm = shortOctaveVoice(48000, 130, .04, direction, 71, .95, true)
    const frames = analyzeOffline(pcm, 48000, mode)
    const hz = direction === 'down' ? 130 : 260
    const notes = buildNotes(frames, mode, 'continuous', pcm.length / 48000)
    assert.ok(notes.some(n => n.start < .9 && n.end > .8 && n.end - n.start >= .03 &&
      Math.abs(n.midi - (69 + 12 * Math.log2(hz / 440))) < .5), `${mode}/${direction}`)
  }
})

test('future context retains even 20ms of low-note evidence under colored noise', () => {
 for (const [noise, correlation, timbre] of [[.04, .8, false], [.1, .95, true]] as const) {
  const sr = 44100, pcm = shortOctaveVoice(sr, 130, noise, 'down', 71, correlation, timbre)
  const live = analyze(pcm, sr, 'song'), offline = analyzeOffline(pcm, sr, 'song')
  const supported = live.filter(f => f.t >= .8 && f.t < .9 && f.frequency && Math.abs(1200 * Math.log2(f.frequency / 130)) < 50)
  assert.ok(supported.length >= 2)
  for (const f of supported) {
    const next = offline.find(n => n.t === f.t)!
    assert.ok(next.frequency && Math.abs(1200 * Math.log2(next.frequency / 130)) < 50)
  }
 }
})

test('offline review remeasures a lost vibrato frame instead of inventing its pitch', () => {
  const sr = 48000
  const pcm = Float32Array.from({ length: sr * 1.3 }, (_, i) => {
    const t = i / sr
    return t < .4 || t > 1.15 ? 0 : .2 * Math.sin(2 * Math.PI * 180 * t - 5 * Math.cos(2 * Math.PI * 5 * t))
  })
  const live = analyze(pcm, sr, 'song'), offline = analyzeOffline(pcm, sr, 'song')
  const index = live.findIndex(f => Math.abs(f.t - 1.13) < .001)
  assert.equal(live[index].state, 'uncertain')
  assert.equal(offline[index].state, 'voiced')
  const expected = 180 + 25 * Math.sin(2 * Math.PI * 5 * offline[index].t)
  assert.ok(Math.abs(1200 * Math.log2(offline[index].frequency! / expected)) < 50)
})

test('offline review preserves actual silence and unvoiced noise between equal pitches', () => {
  for (const mode of ['song', 'speech'] as const) for (const noise of [false, true]) {
    let seed = 19
    const sr = 48000
    const pcm = Float32Array.from({ length: sr * 1.3 }, (_, i) => {
      const t = i / sr
      if (t < .4 || t > 1.15) return 0
      if (t >= .78 && t < .84) {
        seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0
        return noise ? .2 * (seed / 2 ** 32 * 2 - 1) : 0
      }
      return .2 * Math.sin(2 * Math.PI * 220 * t)
    })
    const frames = analyzeOffline(pcm, sr, mode)
    assert.ok(frames.filter(f => f.t >= .8 && f.t <= .82).every(f => f.frequency === null))
    assert.ok(!buildNotes(frames, mode, 'continuous', 1.3).some(n => n.start < .8 && n.end > .82))
  }
})

test('offline review retains low tones and positive/negative cents at both sample rates', () => {
  for (const sr of [44100, 48000]) for (const mode of ['song', 'speech'] as const)
    for (const hz of [82.41, 98, 220, 440 * 2 ** (-30 / 1200), 440 * 2 ** (30 / 1200)]) {
      const pcm = Float32Array.from({ length: Math.round(sr * .8) }, (_, i) =>
        i < sr * .4 ? 0 : .2 * Math.sin(2 * Math.PI * hz * i / sr + .7))
      const frames = analyzeOffline(pcm, sr, mode).filter(f => f.t > .5 && f.t < .7)
      assert.ok(frames.every(f => f.frequency && Math.abs(1200 * Math.log2(f.frequency / hz)) < 20), `${sr}/${mode}/${hz}`)
    }
})
