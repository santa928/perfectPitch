import test from 'node:test'
import assert from 'node:assert/strict'
import { PitchAnalyzer, type PitchFrame } from '../src/analysis/pipeline.ts'
import { sustainedInput } from './fixtures/sustained-voice.ts'
import { analyzeOffline } from '../src/analysis/offline.ts'
import { buildNotes } from '../src/analysis/notes.ts'
import { extractMelody } from '../src/analysis/melody.ts'
import { buildScore } from '../src/notation/score.ts'
import { scoreToPiano } from '../src/notation/score-playback.ts'

/** Issue #20の固定seed・6秒PCM。製品の解析を複製しない。 */
function coverage(frames: PitchFrame[], hz = 220, start = 1, end = 5.8): number {
  const tail = frames.filter(f => f.t >= start && f.t <= end)
  assert.ok(tail.length > 0)
  return tail.filter(f => f.frequency !== null && Math.abs(1200 * Math.log2(f.frequency / hz)) < 50).length / tail.length
}

test('startup noise must not swallow a clear sustained tone', () => {
  const analyzer = new PitchAnalyzer(48000, 'song', undefined, true)
  const frames = [...analyzer.push(sustainedInput(48000)), ...analyzer.finish()]
  const tail = frames.filter(f => f.t >= 1 && f.t <= 5.8)
  const correct = tail.filter(f => f.state === 'voiced' && f.midi !== null && Math.abs(f.midi - 57) < .5)
  console.log(JSON.stringify({ correct: correct.length, total: tail.length,
    lastVoiced: frames.findLast(f => f.frequency !== null)?.t, lastFrame: frames.at(-1)?.t }))
  assert.ok(correct.length / tail.length >= .99,
    `Expected voiced coverage >= 99%; actual ${correct.length}/${tail.length}`)
})

test('3レート・雑音/無音導入・校正あり/なしで長音の99%以上を残す', () => {
  for (const sr of [16000, 44100, 48000]) for (const noise of [false, true]) for (const calibrate of [false, true]) {
    const analyzer = new PitchAnalyzer(sr, 'song', undefined, calibrate)
    const frames = analyzer.push(sustainedInput(sr, noise))
    assert.ok(coverage(frames) >= .99, `${sr}/${noise}/${calibrate}`)
    assert.equal(frames.at(-1)?.t, 5.96)
  }
})

test('一括・1024・可変chunkはPCMと判定根拠を含め完全一致する', () => {
  const sr = 16000, pcm = sustainedInput(sr), original = pcm.slice()
  const expected = new PitchAnalyzer(sr, 'song').push(pcm)
  for (const chunks of [[1024], [1, 127, 2048, 333, 4096]]) {
    const analyzer = new PitchAnalyzer(sr, 'song'), actual: PitchFrame[] = []
    let offset = 0, index = 0
    while (offset < pcm.length) {
      const size = chunks[index++ % chunks.length]
      actual.push(...analyzer.push(pcm.subarray(offset, offset + size)))
      offset += size
    }
    actual.push(...analyzer.finish())
    assert.deepEqual(actual, expected)
  }
  assert.deepEqual(pcm, original)
})

test('live・原PCM再解析・連続音高・メロディ・Scoreでも長音末尾を保持する', () => {
  const pcm = sustainedInput(48000), original = pcm.slice()
  for (const frames of [new PitchAnalyzer(48000, 'song').push(pcm), analyzeOffline(pcm, 48000, 'song')]) {
    assert.ok(coverage(frames) >= .99)
    assert.ok(buildNotes(frames, 'song', 'continuous', 6).at(-1)!.end >= 5.95)
    const melody = extractMelody(frames, 6)
    assert.ok(melody.at(-1)!.end >= 5.95)
    const score = buildScore(melody, 6, 120)
    assert.ok(scoreToPiano(score).notes.at(-1)!.end + score.origin >= 5.9)
  }
  assert.deepEqual(pcm, original)
})

test('雑音直後の弱い声と即発声を捨てず、低音/高音の漸減と低中音の倍音/ビブラートに追従する', () => {
  const sr = 16000
  for (const mode of ['song', 'speech'] as const) for (const hz of [55, 82.41, 220, 880, 1000]) {
    for (const immediate of [false, true]) {
      let phase = 0
      const pcm = sustainedInput(sr, true, 3)
      for (let i = immediate ? 0 : .3 * sr; i < pcm.length; i++) {
        const t = i / sr
        // 端の55/1000Hzは範囲外へ揺らさない。高音の複合条件は下の独立した回帰で測る。
        const complex = hz > 55 && hz < 880
        phase += 2 * Math.PI * hz * (complex ? 2 ** (.2 * Math.sin(2 * Math.PI * 4 * t) / 12) : 1) / sr
        const amplitude = .025 * Math.exp(-t * .5)
        pcm[i] = amplitude * (complex ? .15 * Math.sin(phase) + .6 * Math.sin(phase * 2) + .25 * Math.sin(phase * 3) : Math.sin(phase))
      }
      const frames = new PitchAnalyzer(sr, mode).push(pcm)
      assert.ok(coverage(frames, hz, .5, 2.8) >= .99, `${mode}/${hz}/${immediate}`)
      if (immediate) assert.ok(frames[0].frequency !== null, `${mode}/${hz}: onset`)
    }
  }
})

test('高音の複合stressでは既存YINの誤音程を可視化し、校正による追加欠落を起こさない', () => {
  const sr = 16000, hz = 880, pcm = sustainedInput(sr, true, 3)
  let phase = 0
  for (let i = .3 * sr; i < pcm.length; i++) {
    const t = i / sr
    phase += 2 * Math.PI * hz * 2 ** (.2 * Math.sin(2 * Math.PI * 4 * t) / 12) / sr
    pcm[i] = .025 * Math.exp(-t * .5) * (.15 * Math.sin(phase) + .6 * Math.sin(phase * 2) + .25 * Math.sin(phase * 3))
  }
  const calibrated = new PitchAnalyzer(sr, 'song').push(pcm).filter(f => f.t >= .5 && f.t <= 2.8)
  const control = new PitchAnalyzer(sr, 'song', undefined, false).push(pcm).filter(f => f.t >= .5 && f.t <= 2.8)
  assert.deepEqual(calibrated.map(f => f.frequency), control.map(f => f.frequency))
  assert.ok(calibrated.every(f => f.frequency !== null))
  // この集合を音高99%達成と呼ばない。旧mainの校正無効対照も72/231誤り（報告書参照）。
  console.log(JSON.stringify({ stressHz: hz, correctCoverage: coverage(calibrated, hz, .5, 2.8), frames: calibrated.length }))
})

test('無音・息状/子音状の非周期雑音を音符にせず、実休符と同音再発音を残す', () => {
  const sr = 16000
  for (const mode of ['song', 'speech'] as const) for (const noiseGain of [0, .003, .03, .2]) {
    let seed = 91, colored = 0
    const pcm = sustainedInput(sr, true, 3)
    for (let i = .3 * sr; i < pcm.length; i++) {
      const t = i / sr
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0
      colored = .7 * colored + .3 * (seed / 2 ** 32 * 2 - 1)
      pcm[i] = t < 1 || t >= 2 ? .02 * Math.sin(2 * Math.PI * 220 * t) : noiseGain * colored
    }
    const frames = analyzeOffline(pcm, sr, mode)
    assert.ok(frames.filter(f => f.t >= 1.1 && f.t <= 1.9).every(f => f.frequency === null), `${mode}/${noiseGain}`)
    const notes = buildNotes(frames, mode, 'continuous', 3)
    assert.ok(notes.some(n => n.end <= 1.1) && notes.some(n => n.start >= 1.9))
    assert.ok(coverage(frames, 220, 2.1, 2.8) >= .99)
  }
})

test('絶対音量下限を保ち、高周期性の微小入力を採用しない', () => {
  const pcm = Float32Array.from({ length: 16000 }, (_, i) => .0005 * Math.sin(2 * Math.PI * 220 * i / 16000))
  const frames = new PitchAnalyzer(16000, 'song').push(pcm)
  assert.ok(frames.every(f => f.frequency === null))
  assert.ok(frames.every(f => f.initialGate?.candidateHz != null))
})

test('過大floorからの回復で未校正時より小さい周期背景音を拾わず、声間の休符を残す', () => {
  const sr = 16000, pcm = sustainedInput(sr, true, 2)
  for (let i = .3 * sr; i < pcm.length; i++) {
    const t = i / sr
    pcm[i] = (t >= .8 && t < 1.2 ? .0015 : .16) * Math.sin(2 * Math.PI * 220 * t)
  }
  for (const frames of [new PitchAnalyzer(sr, 'song').push(pcm), analyzeOffline(pcm, sr, 'song')]) {
    assert.ok(frames.filter(f => f.t >= .9 && f.t <= 1.1).every(f => f.frequency === null))
    const notes = buildNotes(frames, 'song', 'continuous', 2)
    assert.equal(notes.length, 2)
    assert.ok(notes[0].end < notes[1].start)
  }
  const background = Float32Array.from({ length: sr }, (_, i) => .0015 * Math.sin(2 * Math.PI * 220 * i / sr))
  for (const calibrate of [false, true]) {
    const frames = new PitchAnalyzer(sr, 'song', undefined, calibrate).push(background)
    assert.ok(frames.every(f => f.frequency === null))
  }
})

test('校正無効のファイル解析は先頭無音の長さで微小周期音への感度を上げない', () => {
  const sr = 16000
  for (const lead of [.4, 3]) for (const mode of ['song', 'speech'] as const) {
    const pcm = Float32Array.from({ length: (lead + 1) * sr }, (_, i) =>
      i < lead * sr ? 0 : .0015 * Math.sin(2 * Math.PI * 220 * i / sr))
    for (const frames of [new PitchAnalyzer(sr, mode, undefined, false).push(pcm),
      analyzeOffline(pcm, sr, mode, undefined, false)]) {
      assert.ok(frames.every(f => f.frequency === null), `${lead}/${mode}: tiny hum must stay unvoiced`)
      assert.ok(frames.every(f => f.initialGate!.backgroundFloor >= .001))
      assert.equal(buildNotes(frames, mode, 'continuous', lead + 1).length, 0)
    }
  }
})

test('雑音校正後の弱い持続音に含まれる本物の100ms低音跳躍を保持する', () => {
  const sr = 16000, pcm = sustainedInput(sr, true, 2)
  let phase = 0
  for (let i = .3 * sr; i < pcm.length; i++) {
    const t = i / sr
    phase += 2 * Math.PI * (t >= 1 && t < 1.1 ? 110 : 220) / sr
    pcm[i] = .02 * Math.sin(phase)
  }
  for (const frames of [new PitchAnalyzer(sr, 'song').push(pcm), analyzeOffline(pcm, sr, 'song')]) {
    const low = frames.filter(f => f.t >= 1 && f.t < 1.1 && f.frequency && Math.abs(1200 * Math.log2(f.frequency / 110)) < 50)
    assert.ok(low.length >= 3)
    const notes = buildNotes(frames, 'song', 'continuous', 2)
    assert.ok(notes.some(n => Math.abs(n.midi - 45) < .5 && n.end - n.start >= .03))
  }
})
