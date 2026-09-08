import test from 'node:test'
import assert from 'node:assert/strict'
import { refineMelodyBoundaries } from '../scripts/evaluation/boundary-candidate.ts'
import type { PianoNote } from '../src/analysis/notes.ts'

/** 原音の発声区間からPCMを作り、わざと遅い推定を与える。 */
function fixture(regions: { start: number; end: number; midi: number }[], rate = 48000) {
  return Float32Array.from({ length: rate * 3 }, (_, i) => {
    const t = i / rate, note = regions.find(n => n.start <= t && t < n.end)
    return note ? .1 * Math.sin(2 * Math.PI * 440 * 2 ** ((note.midi - 69) / 12) * t) : 0
  })
}
const note = (start: number, end: number, midi = 60): PianoNote => ({ start, end, midi, contour: [{ t: start, midi }] })

test('遅い境界を新たなPCM根拠で見直し、原音符と音高を保持する', () => {
  const pcm = fixture([{ start: .4, end: 2.6, midi: 60 }]), notes = [note(.46, 2.54)]
  const before = structuredClone(notes), result = refineMelodyBoundaries(pcm, 48000, notes)
  assert.ok(result.notes[0].start < .45)
  assert.ok(result.notes[0].end > 2.55)
  assert.deepEqual(notes, before)
  assert.equal(result.notes[0].midi, 60)
  assert.equal(result.notes.length, 1)
})

test('真の無音休符、同音再発音、100msのオクターブ音を削除・結合しない', () => {
  const notes = [note(.4, 1), note(1.05, 1.15, 72), note(1.2, 2)]
  const result = refineMelodyBoundaries(fixture(notes), 48000, notes)
  assert.deepEqual(result.notes.map(n => n.midi), [60, 72, 60])
  assert.ok(result.notes[0].end <= 1.005)
  assert.ok(result.notes[1].start >= 1.045 && result.notes[1].end <= 1.155)
  assert.ok(result.notes[2].start >= 1.195)
})

test('PCMに根拠がない区間や別音高へ延長せず、端点を捏造しない', () => {
  const notes = [note(.5, 1), note(1, 1.1, 72), note(1.1, 2)]
  const original = structuredClone(notes)
  const result = refineMelodyBoundaries(new Float32Array(48000 * 3), 48000, notes)
  assert.deepEqual(result.notes, original)
  assert.equal(result.evidence.length, 0)
})

test('解析の半窓で欠けた録音端を持続周期音だけを根拠に延長しない', () => {
  const notes = [note(.035, 2.965)]
  const result = refineMelodyBoundaries(fixture([{ start: 0, end: 3, midi: 60 }]), 48000, notes)
  assert.deepEqual(result.notes, notes)
})

// 以下は成功条件ではなく、不採用を再現可能にする反例。製品へ昇格させない。
test('不採用V2の反例: 歌声後の同音周期環境音で正しい休符を40ms埋める', () => {
  const rate = 48000
  const pcm = Float32Array.from({ length: rate * 2 }, (_, i) => {
    const t = i / rate, gain = t >= .4 && t < 1 ? .01 : t >= 1 && t < 1.2 ? .005 : 0
    return gain * Math.sin(2 * Math.PI * 440 * 2 ** ((60 - 69) / 12) * t)
  })
  const result = refineMelodyBoundaries(pcm, rate, [note(.4, 1)])
  assert.equal(result.notes[0].end, 1.04)
  assert.equal(result.evidence.filter(e => e.side === 'end').length, 4)
})

test('不採用V2の反例: 境界変更時に連続contourを失う', () => {
  const input = [{ ...note(.44, 1.36), contour: [{ t: .44, midi: 60 }, { t: .7, midi: 60.3 }, { t: 1, midi: 59.7 }] }]
  const result = refineMelodyBoundaries(fixture([{ start: .4, end: 1.4, midi: 60 }]), 48000, input)
  assert.equal(input[0].contour.length, 3)
  assert.equal(result.notes[0].contour.length, 1)
})
