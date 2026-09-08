import test from 'node:test'
import assert from 'node:assert/strict'
import { PitchAnalyzer, type PitchFrame } from '../src/analysis/pipeline.ts'
import { analyzeOffline } from '../src/analysis/offline.ts'
import { buildNotes } from '../src/analysis/notes.ts'
import { sourceTransition } from './fixtures/source-transitions.ts'

for (const sr of [16000, 48000]) for (const hz of [110, 173, 330]) {
  test(`${sr}Hz: 別音源の弱い周期背景${hz}Hzへ回復値を持ち越さず、本物の100ms跳躍は保つ`, () => {
    for (const mode of ['song', 'speech'] as const) {
      const background = sourceTransition(sr, hz, .008)
      const melody = sourceTransition(sr, hz, .02, 0, .1, .005)
      for (const run of [
        (pcm: Float32Array) => new PitchAnalyzer(sr, mode).push(pcm),
        (pcm: Float32Array) => analyzeOffline(pcm, sr, mode),
      ]) {
        assert.equal(run(background).filter(f => f.t >= 1.2 && f.t <= 2.8 && f.frequency !== null).length, 0)
        const frames = run(melody)
        const correct = frames.filter(f => f.t >= 1 && f.t <= 1.1 && f.frequency !== null &&
          Math.abs(1200 * Math.log2(f.frequency / hz)) < 50)
        assert.ok(correct.length >= 3, `${hz}/${mode}: jump=${correct.length}`)
        assert.ok(correct.some(f => f.initialGate!.candidatePeriodicity < .97))
        assert.ok(buildNotes(frames, mode, 'continuous', 3).some(n =>
          Math.abs(n.midi - (69 + 12 * Math.log2(hz / 440))) < .5 && n.end - n.start >= .03))
        assert.ok(frames.filter(f => f.t >= 1.3).every(f => f.frequency !== null))
      }
    }
  })
}

test('短い休符後の継続と、長い休符後の再発声の両方を保持する', () => {
  for (const rest of [.1, .4]) for (const hz of [220, 330]) {
    const pcm = sourceTransition(16000, hz, .02, rest)
    for (const frames of [new PitchAnalyzer(16000, 'song').push(pcm), analyzeOffline(pcm, 16000, 'song')]) {
      assert.ok(frames.filter(f => f.t >= 1.04 && f.t <= 1 + rest - .04).every(f => f.frequency === null))
      assert.ok(frames.filter(f => f.t >= 1 + rest + .15 && f.t <= 2.8).every(f => f.frequency !== null))
      assert.ok(buildNotes(frames, 'song', 'continuous', 3).length >= 2)
    }
  }
})

test('400ms休符で古い回復値は失効し、同音の弱い再開も現在の背景から判定する', () => {
  const sr = 16000, pcm = sourceTransition(sr, 220, .02, .4, 2, .005)
  // 前発声の残差より大きい独立背景を置き、古い回復値の流用なら検出できるようにする。
  for (let i = sr; i < sr * 1.4; i++) pcm[i] *= 5 / 3
  for (const frames of [new PitchAnalyzer(sr, 'song').push(pcm), analyzeOffline(pcm, sr, 'song')]) {
    const before = frames.find(f => f.t === .8)!
    assert.ok(before.initialGate!.recoveryExpiresAt! < 1.4)
    const restarted = frames.find(f => f.t >= 1.4 && f.frequency !== null && f.initialGate!.candidatePeriodicity < .97)!
    assert.ok(restarted && restarted.t <= 1.5)
    assert.equal(restarted.initialGate!.recoveryExpiresAt, undefined)
    assert.equal(restarted.initialGate!.effectiveNoiseFloor, restarted.initialGate!.backgroundFloor)
    assert.ok(restarted.initialGate!.backgroundFloor > before.initialGate!.effectiveNoiseFloor)
  }
})

test('音量が60%へ下がる100ms実跳躍もlive/offlineで30ms以上の音符を残す', () => {
  for (const hz of [110, 173, 330]) for (const mode of ['song', 'speech'] as const) {
    const pcm = sourceTransition(16000, hz, .012, 0, .1)
    for (const frames of [new PitchAnalyzer(16000, mode).push(pcm), analyzeOffline(pcm, 16000, mode)]) {
      const correct = frames.filter(f => f.t >= 1 && f.t <= 1.1 && f.frequency !== null &&
        Math.abs(1200 * Math.log2(f.frequency / hz)) < 50)
      assert.ok(correct.length >= 3, `${hz}/${mode}: jump=${correct.length}`)
      assert.ok(buildNotes(frames, mode, 'continuous', 3).some(n =>
        Math.abs(n.midi - (69 + 12 * Math.log2(hz / 440))) < .5 && n.end - n.start >= .03))
    }
  }
})

test('音源境界を含む一括/固定/可変chunkは採否と診断の時計が一致する', () => {
  const pcm = sourceTransition(16000, 173, .008), original = pcm.slice()
  const expected = new PitchAnalyzer(16000, 'speech').push(pcm)
  for (const sizes of [[1024], [31, 2049, 1, 127]]) {
    const analyzer = new PitchAnalyzer(16000, 'speech'), frames: PitchFrame[] = []
    let offset = 0, index = 0
    while (offset < pcm.length) {
      const size = sizes[index++ % sizes.length]
      frames.push(...analyzer.push(pcm.subarray(offset, offset + size)))
      offset += size
    }
    frames.push(...analyzer.finish())
    assert.deepEqual(frames, expected)
  }
  assert.deepEqual(pcm, original)
})
