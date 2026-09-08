import test from 'node:test'
import assert from 'node:assert/strict'
import { buildScore } from '../src/notation/score.ts'
import { scoreToPiano } from '../src/notation/score-playback.ts'
import { scoreToMidi } from '../src/notation/midi.ts'
import { ScoreEditor } from '../src/notation/score-editor.ts'
import { parseMidi } from './helpers/parse-midi.ts'
import type { PianoNote } from '../src/analysis/notes.ts'

/** 検出器を通さず、原音時計だけを持つ入力を作る。 */
function note(start: number, end: number, midi = 60): PianoNote { return { start, end, midi, contour: [{ t: start, midi: midi + .12 }] } }

/** 実Scoreの論理発音と、SMFを独立parseした発音・長さ・テンポ・終端を照合する。 */
function verifyOutputs(score: ReturnType<typeof buildScore>, expected: number[]): void {
  const events = score.measures.flat(), attacks = events.filter(e => e.midi !== null && !e.tieIn)
  const piano = scoreToPiano(score)
  assert.deepEqual(attacks.map(e => e.midi), expected)
  assert.deepEqual(piano.notes.map(n => n.midi), expected)
  const midi = parseMidi(scoreToMidi(score))
  const ons = midi.events.filter(e => e.status === 0x90), offs = midi.events.filter(e => e.status === 0x80)
  assert.deepEqual(ons.map(e => e.data[0]), expected)
  assert.deepEqual(offs.map(e => e.data[0]), expected)
  const tempo = midi.events.find(e => e.type === 0x51)!.data.reduce((value, byte) => value * 256 + byte, 0)
  assert.ok(Math.abs(tempo - 60_000_000 / score.bpm) <= .5)
  for (let i = 0; i < ons.length; i++) {
    assert.ok(offs[i].tick > ons[i].tick)
    assert.equal(ons[i].tick, attacks[i].tick)
    assert.ok(Math.abs(ons[i].tick / 480 * 60 / score.bpm - piano.notes[i].start) < 1e-9)
    assert.ok(Math.abs(offs[i].tick / 480 * 60 / score.bpm - piano.notes[i].end) < 1e-9)
    if (i && ons[i].tick === offs[i - 1].tick)
      assert.ok(midi.events.indexOf(offs[i - 1]) < midi.events.indexOf(ons[i]))
  }
  assert.equal(midi.events.at(-1)!.tick, score.measures.length * 1920)
  assert.ok(events.every(e => Number.isSafeInteger(e.tick) && Number.isSafeInteger(e.ticks) && e.ticks > 0))
  assert.ok(events.every((e, i) => !i || events[i - 1].tick + events[i - 1].ticks === e.tick))
  for (const event of events.filter(e => e.tieIn)) {
    const previous = events[events.indexOf(event) - 1]
    assert.equal(previous.sourceId, event.sourceId)
    assert.equal(previous.tieOut, true)
  }
}

test('120 BPMのC-D-Cの100ms短音と3発音を実Scoreと譜面再生で保持する', () => {
  const input = [[0, .2, 60], [.2, .3, 62], [.3, 1, 60]].map(([start, end, midi]) => ({ start, end, midi, contour: [] }))
  const score = buildScore(input, 1, 120)
  assert.deepEqual(score.measures.flat().filter(e => e.midi !== null && !e.tieIn).map(e => e.midi), [60, 62, 60])
  assert.deepEqual(scoreToPiano(score).notes.map(n => n.midi), [60, 62, 60])
  assert.ok(scoreToPiano(score).notes.every(n => n.end > n.start))
  assert.equal(score.omittedNotes, 0)
  verifyOutputs(score, [60, 62, 60])
})

for (const bpm of [40, 80, 120, 180, 240]) {
  test(`${bpm} BPM: 100ms短音・半音・octave・休符・境界対照は発音を失わず誤差が累積しない`, () => {
    const sixteenth = 60 / bpm / 4
    for (const shift of [-.001, .001]) {
      const start = .3 + 2 * sixteenth + shift
      const input = [note(.1, .2), note(start, start + .1, 61), note(start + .1, start + .2, 73),
        note(start + .3, start + .4, 60), note(start + .8, start + .9, 60)]
      const before = structuredClone(input), score = buildScore(input, start + 1, bpm)
      const piano = scoreToPiano(score).notes
      verifyOutputs(score, input.map(n => n.midi))
      assert.equal(score.omittedNotes, 0)
      assert.deepEqual(input, before)
      for (const [i, source] of input.entries()) {
        assert.ok(Math.abs(piano[i].start + score.origin - source.start) <= .050000001)
        assert.ok(Math.abs(piano[i].end + score.origin - source.end) <= .050000001)
        const fragments = score.measures.flat().filter(e => e.sourceId === i)
        assert.ok(fragments.length)
        assert.equal(fragments.filter(e => !e.tieIn).length, 1)
        if (i && source.start > input[i - 1].end + 1e-8) assert.ok(piano[i].start > piano[i - 1].end)
      }
    }
  })

  test(`${bpm} BPM: 先頭・末尾・小節境界の短音と同音2〜4発音、5〜10秒長音`, () => {
    const barSeconds = 240 / bpm
    for (const count of [2, 3, 4]) {
      const input = Array.from({ length: count }, (_, i) => note(i * .1, (i + 1) * .1))
      verifyOutputs(buildScore(input, count * .1, bpm), input.map(n => n.midi))
    }
    for (const duration of [5, 10]) {
      const score = buildScore([note(0, duration)], duration, bpm)
      verifyOutputs(score, [60])
      assert.ok(score.measures.flat().length < 30, '長音を最小音価の大量のタイにしない')
    }
    const input = [note(0, .1), note(barSeconds - .05, barSeconds + .05, 62), note(barSeconds + .1, barSeconds + .2, 60)]
    verifyOutputs(buildScore(input, barSeconds + .2, bpm), [60, 62, 60])
  })
}

test('単純な四分・八分音符は最小音価へ分割せず、BPM変更と履歴も原音を変更しない', () => {
  const input = [note(.2, .7), note(.7, .95, 62), note(.95, 1.2, 64)]
  const score = buildScore(input, 1.2, 120), before = structuredClone(score)
  assert.deepEqual(score.measures.flat().filter(e => e.midi !== null).map(e => e.ticks), [480, 240, 240])
  const editor = new ScoreEditor(score)
  const selected = editor.notes[1]
  editor.edit(selected.id, { midi: 63 })
  verifyOutputs(editor.score, [60, 63, 64])
  assert.equal(editor.notes[1].sourceId, 1)
  editor.undo(); verifyOutputs(editor.score, [60, 62, 64])
  editor.redo(); verifyOutputs(editor.score, [60, 63, 64])
  editor.setTempo(80)
  assert.equal(editor.origin, .2)
  assert.deepEqual(editor.score.sourceNotes, score.sourceNotes)
  verifyOutputs(editor.score, [60, 63, 64])
  assert.deepEqual(score, before)
  assert.throws(() => editor.edit(selected.id, { ticks: 1 }), RangeError)
})

test('削除した原音符と同じ音を手で追加しても対応情報の変更を編集として保持しresetできる', () => {
  const editor = new ScoreEditor(buildScore([note(0, .5)], 1, 120)), original = editor.notes[0]
  editor.remove(original.id)
  editor.insert({ tick: original.tick, ticks: original.ticks, midi: original.midi })
  assert.equal(editor.notes[0].sourceId, undefined, '手動音に原音符の対応を捏造しない')
  assert.equal(editor.modified, true, '対応情報が変わった譜面を未編集扱いにしない')
  editor.reset()
  assert.equal(editor.notes[0].sourceId, 0)
  assert.equal(editor.modified, false)
})

test('60秒600短音は有限・正長・順序・休符を維持し、変換・編集・MIDIが完了する', () => {
  const input = Array.from({ length: 600 }, (_, i) => note(i / 10, (i + .7) / 10, 48 + i % 25))
  const before = structuredClone(input), start = performance.now()
  const score = buildScore(input, 60, 240), buildMs = performance.now() - start
  const editStart = performance.now(), editor = new ScoreEditor(score)
  editor.edit(editor.notes[300].id, { midi: 72 }); editor.undo(); editor.redo(); editor.undo()
  const editMs = performance.now() - editStart, midiStart = performance.now()
  scoreToMidi(editor.score)
  const midiMs = performance.now() - midiStart
  verifyOutputs(editor.score, input.map(n => n.midi))
  for (const [i, n] of scoreToPiano(score).notes.entries()) {
    assert.ok(Math.abs(n.start - input[i].start) <= .050000001)
    assert.ok(Math.abs(n.end - input[i].end) <= .050000001)
  }
  assert.ok(Math.max(buildMs, editMs, midiMs) < 1000, JSON.stringify({ buildMs, editMs, midiMs }))
  assert.deepEqual(input, before)
})

test('不正・重複・表現不能入力を対象付きで示し、原音符は保持して手修正できる', () => {
  const invalid = [note(-1, 0), note(0, .5), note(.1, .2, 62), note(.5, .6, NaN), note(.6, Infinity)]
  const score = buildScore(invalid, 1, 120)
  assert.equal(score.omittedNotes, 4)
  assert.deepEqual(score.sourceNotes?.map(({ sourceId, ...n }) => n), invalid)
  assert.deepEqual(score.issues?.flatMap(i => i.sourceIds).sort(), [0, 2, 3, 4])
  const dense = Array.from({ length: 100 }, (_, i) => note(i / 10000, (i + 1) / 10000))
  const blocked = buildScore(dense, .01, 40)
  assert.equal(blocked.omittedNotes, 100)
  assert.equal(blocked.sourceNotes?.length, 100)
  assert.match(blocked.issues![0].reason, /50ms/)
  assert.equal(scoreToPiano(blocked).notes.length, 0)
  const editor = new ScoreEditor(blocked)
  editor.insert({ tick: 0, ticks: 15, midi: 60 })
  verifyOutputs(editor.score, [60])
  assert.throws(() => scoreToPiano({ ...score, ppq: 96 }), RangeError)
  const unsupported = buildScore([note(0, .5)], 1, 120)
  unsupported.measures[0][0].ticks = 1
  assert.throws(() => scoreToPiano(unsupported), RangeError, '再生だけが表示不能な音価を受け入れない')
  const tiny = buildScore([note(1, 1 + 1e-9)], 2, 120)
  assert.equal(scoreToPiano(tiny).notes.length, 1, '数値許容差で有効な短音自体を0長へ消さない')
  const unordered = buildScore([note(.5, .8, 62), note(NaN, 1), note(0, .3)], 1, 120)
  verifyOutputs(unordered, [60, 62])
  assert.equal(unordered.omittedNotes, 1, '不正時刻をsortへ混ぜて有効な音を誤棄却しない')
  const clipped = buildScore([note(0, 1.2)], 1, 120)
  assert.ok(clipped.issues?.some(issue => issue.reason.includes('録音終端')))
  assert.equal(clipped.sourceNotes?.[0].end, 1.2)
  const smallRest = buildScore([note(0, .1), note(.100000001, .2, 62)], .2, 120)
  const restPiano = scoreToPiano(smallRest).notes
  assert.ok(restPiano[1].start > restPiano[0].end, '数値許容差より大きい実休符を消さない')
  assert.ok(smallRest.issues?.some(issue => issue.reason.includes('休符')))
  const overlap = buildScore([note(0, .100000005), note(.1, .2, 62)], .2, 120)
  assert.equal(overlap.omittedNotes, 1)
  assert.deepEqual(overlap.issues?.[0].sourceIds, [1])
  const floating = buildScore([note(0, .1 + .2), note(.3, .6, 62)], .6, 120)
  assert.equal(floating.omittedNotes, 0, '数ULPの算術誤差だけは隣接境界として扱う')
})

test('別原音IDには双方向タイが誤付与されても同音を結合しない', () => {
  const score = buildScore([note(0, .5), note(.5, 1)], 1, 120)
  score.measures[0][0].tieOut = true
  score.measures[0][1].tieIn = true
  assert.equal(scoreToPiano(score).notes.length, 2)
  assert.equal(parseMidi(scoreToMidi(score)).events.filter(e => e.status === 0x90).length, 2)
  assert.deepEqual(new ScoreEditor(score).notes.map(n => n.sourceId), [0, 1])
})
