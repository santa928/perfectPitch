import { sustainedInput } from '../../tests/fixtures/sustained-voice.ts'
import { shortOctaveVoice } from '../../tests/fixtures/period-voice.ts'
import type { F0, Note } from './metrics.ts'

export interface SyntheticClip { id: string; categories: string[]; sampleRate: number; samples: Float32Array; reference: Note[]; f0: F0[] }

/** 既知の発声区間・連続F0と雑音を生成する。全条件は調整/回帰専用でholdoutと呼ばない。 */
export function syntheticCorpus(): SyntheticClip[] {
  const rate = 48000, duration = 4
  const cases = [
    'long', 'crescendo', 'decrescendo', 'vibrato', 'glide', 'short100', 'semitone100',
    'octave100', 'reattack', 'true-rest', 'weak-fundamental', 'strong-harmonics',
    'onset-offset', 'white-noise', 'colored-noise', 'periodic-environment',
  ]
  const clips: SyntheticClip[] = cases.map(id => {
    const reference: Note[] = id === 'periodic-environment' ? [] :
      id === 'short100' ? [{ start: 1, end: 1.1, midi: 60 }] :
      ['semitone100', 'octave100'].includes(id) ? [
        { start: .4, end: 1.2, midi: 60 }, { start: 1.2, end: 1.3, midi: id === 'semitone100' ? 61 : 72 }, { start: 1.3, end: 3.6, midi: 60 }] :
      ['reattack', 'true-rest'].includes(id) ? [{ start: .4, end: 1.9, midi: 60 }, { start: id === 'true-rest' ? 2.1 : 1.9, end: 3.6, midi: 60 }] :
      id === 'onset-offset' ? [{ start: 0, end: .8, midi: 57 }, { start: 1.2, end: 4, midi: 64 }] :
        [{ start: .4, end: 3.6, midi: 60 }]
    const hzAt = (t: number): number => {
      const note = reference.find(n => t >= n.start && t < n.end)
      if (!note) return 0
      const change = id === 'vibrato' ? .35 * Math.sin(2 * Math.PI * 5.3 * t) :
        id === 'glide' ? -3 * Math.max(0, 1 - (t - note.start) / .15) : 0
      return 440 * 2 ** ((note.midi + change - 69) / 12)
    }
    let seed = 21091, colored = 0, phase = 0
    const samples = Float32Array.from({ length: rate * duration }, (_, i) => {
      const t = i / rate, hz = hzAt(t)
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0
      const white = seed / 2 ** 31 - 1
      colored = .95 * colored + Math.sqrt(1 - .95 ** 2) * white
      const noise = id === 'white-noise' ? .025 * white : id === 'colored-noise' ? .025 * colored : 0
      if (id === 'periodic-environment') return .06 * Math.sin(2 * Math.PI * 120 * t)
      if (!hz) return noise
      phase += 2 * Math.PI * hz / rate
      let gain = id === 'crescendo' ? .015 + .15 * (t - .4) / 3.2 :
        id === 'decrescendo' ? .165 - .15 * (t - .4) / 3.2 : .15
      if (id === 'reattack' && t >= 1.83 && t < 1.95) gain *= .15
      const fundamental = id === 'weak-fundamental' ? .06 : id === 'strong-harmonics' ? .2 : 1
      return gain * (fundamental * Math.sin(phase) + .65 * Math.sin(2 * phase) + .3 * Math.sin(3 * phase)) + noise
    })
    return { id: `synthetic-${id}`, categories: [id], sampleRate: rate, samples, reference,
      f0: Array.from({ length: Math.round(duration / .01) }, (_, i) => ({ t: i * .01, hz: hzAt(i * .01) })) }
  })
  clips.push({ id: 'synthetic-pr23-long', categories: ['long', 'noise-floor-recovery'], sampleRate: rate,
    samples: sustainedInput(rate, true, 6), reference: [{ start: .3, end: 6, midi: 57 }],
    f0: Array.from({ length: 600 }, (_, i) => ({ t: i * .01, hz: i < 30 ? 0 : 220 })) })
  clips.push({ id: 'synthetic-pr19-octave', categories: ['octave100', 'weak-fundamental', 'white-noise'], sampleRate: rate,
    samples: shortOctaveVoice(rate), reference: [
      { start: .4, end: .8, midi: 69 + 12 * Math.log2(260 / 440) },
      { start: .8, end: .9, midi: 69 + 12 * Math.log2(130 / 440) },
      { start: .9, end: 1.15, midi: 69 + 12 * Math.log2(260 / 440) }],
    f0: Array.from({ length: 130 }, (_, i) => ({ t: i * .01,
      hz: i < 40 || i >= 115 ? 0 : i >= 80 && i < 90 ? 130 : 260 })) })
  return clips
}

/** 解析用のfloat32 mono WAV。PCM値を量子化せず同じ入力を各方式へ渡す。 */
export function floatWav(samples: Float32Array, sampleRate: number): Uint8Array {
  const buffer = new ArrayBuffer(44 + samples.byteLength), view = new DataView(buffer)
  const text = (offset: number, value: string) => [...value].forEach((c, i) => view.setUint8(offset + i, c.charCodeAt(0)))
  text(0, 'RIFF'); view.setUint32(4, 36 + samples.byteLength, true); text(8, 'WAVE'); text(12, 'fmt ')
  view.setUint32(16, 16, true); view.setUint16(20, 3, true); view.setUint16(22, 1, true)
  view.setUint32(24, sampleRate, true); view.setUint32(28, sampleRate * 4, true)
  view.setUint16(32, 4, true); view.setUint16(34, 32, true); text(36, 'data'); view.setUint32(40, samples.byteLength, true)
  samples.forEach((value, i) => view.setFloat32(44 + i * 4, value, true))
  return new Uint8Array(buffer)
}
