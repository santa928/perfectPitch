import test from 'node:test'
import assert from 'node:assert/strict'
import { extractMelody, suggestTempo } from '../src/analysis/melody.ts'
import type { PitchFrame } from '../src/analysis/pipeline.ts'
import { analyzeOffline } from '../src/analysis/offline.ts'

/** Known pitch frames isolate note inference from microphone and F0 accuracy. */
function framesFor(pitch: (t: number) => number | null, duration = 2): PitchFrame[] {
  return Array.from({ length: duration * 100 }, (_, i) => {
    const t = .005 + i / 100, midi = pitch(t)
    return { t, midi, frequency: midi === null ? null : 440 * 2 ** ((midi - 69) / 12),
      state: midi === null ? 'silence' : 'voiced', rms: midi === null ? 0 : .1, periodicity: .99 }
  })
}

test('melody keeps a 100ms octave inside vibrato without making vibrato into extra keys', () => {
  for (const center of [46, 60, 69]) for (const depth of [.3, .55, .7]) for (const speed of [4, 6, 8]) {
    const frames = framesFor(t => center + (t >= .8 && t < .9 ? 12 : 0) + depth * Math.sin(2 * Math.PI * speed * t))
    const before = structuredClone(frames)
    const notes = extractMelody(frames, 2)
    assert.deepEqual(notes.map(n => n.midi), [center, center + 12, center])
    assert.ok(notes[1].end - notes[1].start >= .08)
    assert.deepEqual(frames, before)
  }
})

test('melody preserves semitone short notes, real rests, and repeated notes', () => {
  const frames = framesFor(t => t < .5 ? 60 : t < .6 ? 61 : t < 1 ? 60 : t < 1.04 ? null : 60)
  const notes = extractMelody(frames, 2)
  assert.deepEqual(notes.map(n => n.midi), [60,61,60,60])
  assert.ok(Math.abs(notes[1].start - .5) < .011)
  assert.ok(Math.abs(notes[1].end - .6) < .011)
  assert.ok(notes[3].start - notes[2].end >= .039)
  assert.ok(notes.every(n => n.contour.every(p => p.midi === n.midi)))
})

test('melody keeps silence, missing clock spans and uncertain frames blank', () => {
  assert.deepEqual(extractMelody(framesFor(() => null), 2), [])
  assert.deepEqual(extractMelody([], 0), [])
  const frames = framesFor(() => 60).filter(f => f.t < .5 || f.t >= .55)
  frames[90] = { ...frames[90], midi: null, frequency: null, state: 'uncertain' }
  const notes = extractMelody(frames, 2)
  assert.equal(notes.length, 3)
  assert.ok(notes[1].start - notes[0].end >= .049)
  assert.ok(notes[2].start - notes[1].end >= .009)
})

test('tempo proposal fits a known grid, offers octave-tempo alternatives and marks insufficient evidence', () => {
  const notes = [0,.6,1.2,1.5,1.8,2.4].map((start,i,all) => ({start,end:all[i+1]??3,midi:60+i,contour:[]}))
  const result = suggestTempo(notes)
  assert.ok([result.bpm,...result.alternatives].some(bpm => Math.abs(bpm-100)<=1))
  assert.equal(result.reliable, true)
  assert.deepEqual(suggestTempo([]), {bpm:120,alternatives:[],reliable:false})
  assert.equal(suggestTempo(notes.slice(0,1)).reliable, false)
})

test('irregular short phrases do not claim a reliable tempo from a searched grid alone', () => {
  const starts=[0,.37,.91,1.44,2.03,2.71], lengths=[.17,.41,.23,.36,.19,.47]
  const notes=starts.map((start,i)=>({start,end:start+lengths[i],midi:60+i,contour:[]}))
  assert.equal(suggestTempo(notes).reliable,false)
})

test('a deep sustained amplitude valley with renewed onset separates repeated pitch without a null frame', () => {
  const frames=framesFor(()=>60)
  for(const frame of frames) if(frame.t>=.97&&frame.t<1.03) frame.rms=.02
  const notes=extractMelody(frames,2)
  assert.deepEqual(notes.map(n=>n.midi),[60,60])
  assert.ok(notes[0].end>=.96&&notes[0].end<=1.04)
  assert.equal(notes[0].end,notes[1].start)
  const gentle=framesFor(t=>60+.4*Math.sin(2*Math.PI*6*t))
  gentle.forEach(f=>{f.rms=.08+.02*Math.sin(2*Math.PI*5*f.t)})
  assert.equal(extractMelody(gentle,2).length,1)
})

test('same-pitch reattack survives the actual 80ms analysis window', () => {
  const pcm=Float32Array.from({length:48000*2},(_,i)=>{
    const t=i/48000
    if(t<.4||t>=1.8)return 0
    return (t>=.97&&t<1.09?.04:.2)*Math.sin(2*Math.PI*220*t)
  })
  const frames=analyzeOffline(pcm,48000,'song')
  assert.ok(frames.filter(f=>f.t>=.97&&f.t<1.09).every(f=>f.state==='voiced'))
  const notes=extractMelody(frames,2)
  assert.deepEqual(notes.map(n=>n.midi),[57,57])
  assert.ok(notes[1].start>=1.04&&notes[1].start<=1.14)
})
