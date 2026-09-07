import test from 'node:test'
import assert from 'node:assert/strict'
import { stabilizePitchFrames } from '../src/analysis/continuity.ts'
import type { PitchFrame } from '../src/analysis/pipeline.ts'
import { extractMelody } from '../src/analysis/melody.ts'

/** 約C4の声に20msだけ約D2が混じる検出列。前後はわずかに異なる高さ。 */
function excursion(): PitchFrame[] {
  return Array.from({ length: 50 }, (_, i) => {
    const midi = i < 20 ? 60.1 : i < 22 ? 41 : 60.4
    return { t: i * .01, midi, frequency: 440 * 2 ** ((midi - 69) / 12), rms: .1, periodicity: .99, state: 'voiced' }
  })
}

test('表示用の急落補正はcentsを補間し、原検出値と時刻を変えない', () => {
  const frames = excursion(), original = structuredClone(frames)
  const corrected = stabilizePitchFrames(frames)
  assert.ok(Math.abs(corrected[20].midi! - 60.2) < 1e-9)
  assert.ok(Math.abs(corrected[21].midi! - 60.3) < 1e-9)
  assert.ok(Math.abs(69 + 12 * Math.log2(corrected[20].frequency! / 440) - 60.2) < 1e-9)
  assert.deepEqual(corrected.map(frame => frame.t), original.map(frame => frame.t))
  assert.deepEqual(frames, original)
  assert.deepEqual(stabilizePitchFrames(corrected), corrected)
})

test('休符・不明・時刻欠落・不安定な支持音・別の音へ移る低音を補間しない', () => {
  for (const index of [18, 20, 23]) {
    for (const state of ['silence', 'uncertain'] as const) {
      const frames = excursion()
      frames[index] = { ...frames[index], midi: null, frequency: null, state }
      assert.deepEqual(stabilizePitchFrames(frames), frames)
    }
    const frames = excursion()
    frames.splice(index, 1)
    assert.deepEqual(stabilizePitchFrames(frames), frames)
  }
  const different = excursion().map((frame, i) => i >= 22 ? { ...frame, midi: 63 } : frame)
  assert.deepEqual(stabilizePitchFrames(different), different)
  const unstable = excursion()
  unstable[23] = { ...unstable[23], midi: 61.5 }
  assert.deepEqual(stabilizePitchFrames(unstable), unstable)
})

test('発声境界と滑らかな下降は保持し、後続が揃うまでは急落を確定補正しない', () => {
  const frames = excursion()
  for (const partial of [frames.slice(0, 22), frames.slice(0, 24), frames.slice(20)])
    assert.deepEqual(stabilizePitchFrames(partial), partial)
  const glide = frames.map((frame, i) => ({ ...frame, midi: 65 - i * .4 }))
  assert.deepEqual(stabilizePitchFrames(glide), glide)
})

test('歌声の標準採譜でも20msの急落を除き、40〜100msの低音と原値は残す', () => {
  for (const count of [2, 4, 10]) {
    const frames: PitchFrame[] = Array.from({ length: 60 }, (_, i) => {
      const midi = i >= 20 && i < 20 + count ? 41 : 60
      return { t: i * .01, midi, frequency: 440 * 2 ** ((midi - 69) / 12), rms: .1, periodicity: .99, state: 'voiced' }
    })
    const before = structuredClone(frames)
    assert.deepEqual(extractMelody(frames, .6).map(note => note.midi), count === 2 ? [60] : [60, 41, 60])
    assert.deepEqual(frames, before)
  }
})
