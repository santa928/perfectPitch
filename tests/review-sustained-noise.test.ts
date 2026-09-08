import test from 'node:test'
import assert from 'node:assert/strict'
import { PitchAnalyzer, type PitchFrame } from '../src/analysis/pipeline.ts'
import { analyzeOffline } from '../src/analysis/offline.ts'
import { sustainedNoise } from './fixtures/sustained-noise.ts'
import { buildNotes } from '../src/analysis/notes.ts'

/** 固定した後半窓を分母にし、nullも誤音程も取りこぼしとして数える。 */
function assertTail(frames: PitchFrame[], start = 1): void {
  const tail = frames.filter(f => f.t >= start && f.t <= 5.8)
  const correct = tail.filter(f => f.frequency !== null && Math.abs(1200 * Math.log2(f.frequency / 220)) < 50)
  console.log(JSON.stringify({ correct: correct.length, total: tail.length,
    lastVoiced: frames.findLast(f => f.frequency !== null)?.t, at5: frames.find(f => f.t === 5) }))
  assert.ok(correct.length / tail.length >= .95, `Expected coverage >= 95%; actual ${correct.length}/${tail.length}`)
}

for (const sr of [16000, 44100, 48000]) for (const path of ['live', 'offline'] as const) {
  test(`sustained voice with ongoing noise: ${sr}/${path}`, () => {
    const pcm = sustainedNoise(sr)
    assertTail(path === 'live' ? new PitchAnalyzer(sr, 'song').push(pcm) : analyzeOffline(pcm, sr, 'song'))
  })
}

test('回復済みの純音へ途中から定常雑音が重なっても発声を維持する', () => {
  const pcm = sustainedNoise(16000, 2)
  assertTail(new PitchAnalyzer(16000, 'song').push(pcm), 2.2)
  assertTail(analyzeOffline(pcm, 16000, 'song'), 2.2)
})

test('同じ後半の校正なし/無音導入の対照が検出できる', () => {
  for (const sr of [16000, 48000]) {
    assertTail(new PitchAnalyzer(sr, 'song', undefined, false).push(sustainedNoise(sr)))
    assertTail(new PitchAnalyzer(sr, 'song').push(sustainedNoise(sr, .8, true)))
  }
})

test('弱い雑音混じり発声だけでは校正回復を確証できない限界を記録する', () => {
  const pcm = sustainedNoise(16000, .3, false, false)
  const frames = new PitchAnalyzer(16000, 'song').push(pcm)
  // 機械音との識別根拠なしに自己回復する案は不採用。改善済みの条件には数えない。
  assert.ok(frames.every(f => f.initialGate?.recoveryStart === undefined))
  assert.equal(frames.filter(f => f.t >= 1 && f.t <= 5.8 && f.frequency !== null).length, 0)
})

test('offlineは回復確認を待っていた発声の先頭も原PCM候補から再判定する', () => {
  const pcm = sustainedNoise(16000, .3, false, false)
  // 開始100ms後から30ms以上の明瞭な音が得られた場合だけ、同じ支持区間を見直す。
  for (let i = .4 * 16000; i < .8 * 16000; i++) pcm[i] = .02 * Math.sin(2 * Math.PI * 220 * i / 16000)
  const original = pcm.slice()
  const frames = analyzeOffline(pcm, 16000, 'song')
  const onset = frames.find(f => f.t === .36)!
  assert.ok(onset.frequency !== null && Math.abs(1200 * Math.log2(onset.frequency / 220)) < 50)
  assert.deepEqual(pcm, original)
  assert.equal(onset.voicingReview?.source, 'confirmed-noise-floor')
})

test('雑音混じりの持続音でも実休符・同音再発音・100ms低音をlive/offlineで保持する', () => {
  const sr = 16000
  let seed = 1, phase = 0
  const pcm = Float32Array.from({ length: sr * 3 }, (_, i) => {
    const t = i / sr
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0
    const white = seed / 2 ** 32 * 2 - 1
    phase += 2 * Math.PI * (t >= 2 && t < 2.1 ? 110 : 220) / sr
    if (t < .3) return .05 * white
    return (t >= 1.2 && t < 1.6 ? 0 : (t < .8 ? .16 : .02) * Math.sin(phase)) + .005 * white
  })
  for (const mode of ['song', 'speech'] as const) for (const frames of [
    new PitchAnalyzer(sr, mode).push(pcm), analyzeOffline(pcm, sr, mode),
  ]) {
    assert.ok(frames.filter(f => f.t >= 1.3 && f.t <= 1.5).every(f => f.frequency === null))
    const notes = buildNotes(frames, mode, 'continuous', 3)
    assert.ok(notes.some(n => n.end <= 1.3) && notes.some(n => n.start >= 1.5))
    assert.ok(notes.some(n => Math.abs(n.midi - 45) < .5 && n.end - n.start >= .03))
    assert.ok(notes.at(-1)!.end >= 2.95)
  }
})

test('校正回復の支持を非周期区間で捨て、単発候補だけでfloorを永続変更しない', () => {
  const sr = 16000, pcm = sustainedNoise(sr, .3, false, false)
  // 100msの証拠が揃う前に毎回中断する、雑音だけと短い周期音の組み合わせ。
  let seed = 7
  for (let i = .3 * sr; i < pcm.length; i++) {
    const t = i / sr
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0
    pcm[i] = (t % .25 < .07 ? .02 * Math.sin(2 * Math.PI * 220 * t) : 0)
      + .005 * (seed / 2 ** 32 * 2 - 1)
  }
  const frames = new PitchAnalyzer(sr, 'song').push(pcm)
  assert.ok(frames.every(f => f.initialGate?.recoveryStart === undefined))
})

test('雑音だけで有声やoffline回復を作らず、chunk境界は回復時刻を変えない', () => {
  const sr = 16000
  let seed = 31
  const noise = Float32Array.from({ length: sr * 3 }, (_, i) => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0
    return (i < .3 * sr ? .05 : .005) * (seed / 2 ** 32 * 2 - 1)
  })
  for (const frames of [new PitchAnalyzer(sr, 'song').push(noise), analyzeOffline(noise, sr, 'song')]) {
    assert.ok(frames.every(f => f.frequency === null && f.voicingReview === undefined))
    assert.equal(buildNotes(frames, 'song', 'continuous', 3).length, 0)
  }
  const pcm = sustainedNoise(sr), original = pcm.slice()
  const expected = new PitchAnalyzer(sr, 'song').push(pcm)
  for (const sizes of [[1024], [127, 1, 2048, 333]]) {
    const analyzer = new PitchAnalyzer(sr, 'song'), frames: PitchFrame[] = []
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

for (const withVoice of [false, true]) {
  test(`周期雑音だけで自己回復せず、先行音${withVoice ? 'あり' : 'なし'}でも弱い背景音に回復値を漏らさない`, () => {
    const sr = 16000
    let seed = withVoice ? 923 : 71
    const pcm = Float32Array.from({ length: sr * 3 }, (_, i) => {
      const t = i / sr
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0
      const white = seed / 2 ** 32 * 2 - 1
      if (t < .3) return .05 * white
      if (withVoice && t < 1) return .02 * Math.sin(2 * Math.PI * 220 * t) + .003 * white
      return .012 * Math.sin(2 * Math.PI * 173 * t) + (withVoice ? .006 : .004) * white
    })
    const mode = withVoice ? 'speech' : 'song'
    for (const frames of [new PitchAnalyzer(sr, mode).push(pcm), analyzeOffline(pcm, sr, mode)]) {
      const tail = frames.filter(f => f.t >= (withVoice ? 1.2 : .6) && f.t <= 2.8)
      assert.equal(tail.filter(f => f.frequency !== null).length, 0)
      assert.ok(tail.every(f => f.voicingReview === undefined))
      if (withVoice) assert.ok(frames.some(f => f.initialGate?.recoveryStart !== undefined))
    }
  })
}

test('回復後の静かな背景でも非周期PCM由来の基準が追従し、後続の弱い発声を妨げない', () => {
  const sr = 16000
  let seed = 923
  const pcm = Float32Array.from({ length: sr * 12 }, (_, i) => {
    const t = i / sr
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0
    const white = seed / 2 ** 32 * 2 - 1
    if (t < .3) return .05 * white
    if (t < 1) return .02 * Math.sin(2 * Math.PI * 220 * t) + .003 * white
    if (t < 10) return .005 * white
    return .012 * Math.sin(2 * Math.PI * 173 * t) + .006 * white
  })
  for (const frames of [new PitchAnalyzer(sr, 'speech').push(pcm), analyzeOffline(pcm, sr, 'speech')]) {
    const quiet = frames.filter(f => f.t >= 1.2 && f.t <= 9)
    assert.ok(quiet.every(f => f.state === 'silence'))
    const tail = frames.filter(f => f.t >= 10.2 && f.t <= 11.8)
    assert.ok(tail.filter(f => f.frequency !== null).length / tail.length >= .95)
    assert.ok(tail.every(f => f.initialGate!.backgroundFloor < .004))
  }
})

test('未解決: 明瞭な先行音の回復値を別音高の周期背景音へ引き継がない', () => {
  const sr = 16000
  let seed = 923
  const pcm = Float32Array.from({ length: sr * 3 }, (_, i) => {
    const t = i / sr
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0
    const white = seed / 2 ** 32 * 2 - 1
    if (t < .3) return .05 * white
    if (t < 1) return .02 * Math.sin(2 * Math.PI * 220 * t) + .003 * white
    return .008 * Math.sin(2 * Math.PI * 173 * t) + .003 * white
  })
  const counts = [new PitchAnalyzer(sr, 'speech').push(pcm), analyzeOffline(pcm, sr, 'speech')]
    .map(frames => frames.filter(f => f.t >= 1.2 && f.t <= 2.8 && f.frequency !== null).length)
  // Draftのブロッカー。期待を実装結果へ合わせず、解消が必要な回帰として失敗させる。
  assert.deepEqual(counts, [0, 0], '別音高の背景音はlive/offlineとも有声0窓が必要')
})
