import { test } from 'node:test'
import assert from 'node:assert/strict'
import { scoreToMidi } from '../src/notation/midi.ts'
import { scoreToPiano } from '../src/notation/score-playback.ts'
import type { Score, ScoreEvent } from '../src/notation/score.ts'

type ParsedEvent = { tick: number; status: number; type?: number; data: number[]; deltaBytes: number[] }

/** 出力writerとは独立してSMFのチャンク、VLQ、イベント長を検査する最小parser。 */
function parseMidi(bytes: Uint8Array): { format: number; tracks: number; ppq: number; events: ParsedEvent[] } {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const tag = (offset: number): string => String.fromCharCode(...bytes.slice(offset, offset + 4))
  assert.equal(tag(0), 'MThd')
  assert.equal(view.getUint32(4), 6)
  const format = view.getUint16(8), tracks = view.getUint16(10), ppq = view.getUint16(12)
  assert.equal(tag(14), 'MTrk')
  const end = 22 + view.getUint32(18)
  assert.equal(end, bytes.length)
  let offset = 22, tick = 0
  /** 最大4byteのVLQを読み、区切りを越える不正なイベントを拒否する。 */
  const vlq = (): number => {
    let value = 0
    for (let i = 0; i < 4; i++) {
      assert.ok(offset < end)
      const byte = bytes[offset++]
      value = value * 128 + (byte & 127)
      if (byte < 128) return value
    }
    assert.fail('VLQ exceeds four bytes')
  }
  const events: ParsedEvent[] = []
  while (offset < end) {
    const start = offset
    tick += vlq()
    const deltaBytes = [...bytes.slice(start, offset)], status = bytes[offset++]
    if (status === 0xff) {
      const type = bytes[offset++], size = vlq()
      const data = [...bytes.slice(offset, offset + size)]
      offset += size
      events.push({ tick, status, type, data, deltaBytes })
    } else {
      assert.ok([0x80, 0x90, 0xc0].includes(status))
      const size = status === 0xc0 ? 1 : 2
      const data = [...bytes.slice(offset, offset + size)]
      assert.ok(data.every(byte => byte < 128))
      offset += size
      events.push({ tick, status, data, deltaBytes })
    }
    assert.ok(offset <= end)
  }
  assert.equal(events.at(-1)?.type, 0x2f)
  return { format, tracks, ppq, events }
}

test('format 0 MIDI keeps score ties, rests, reattacks, piano and the last measure endpoint', () => {
  const score: Score = { bpm: 120, origin: 7, omittedNotes: 2, measures: [
    [
      { tick: 0, ticks: 4, midi: null, tieIn: false, tieOut: false },
      { tick: 4, ticks: 4, midi: 60, tieIn: false, tieOut: true },
      { tick: 8, ticks: 8, midi: 60, tieIn: true, tieOut: true },
    ],
    [
      { tick: 16, ticks: 4, midi: 60, tieIn: true, tieOut: false },
      { tick: 20, ticks: 4, midi: 60, tieIn: false, tieOut: false },
      { tick: 24, ticks: 8, midi: null, tieIn: false, tieOut: false },
    ],
  ] }
  const before = structuredClone(score), result = parseMidi(scoreToMidi(score))
  assert.deepEqual([result.format, result.tracks, result.ppq], [0, 1, 480])
  assert.deepEqual(result.events.filter(e => e.status === 0xff).map(e => [e.tick, e.type, e.data]), [
    [0, 0x51, [0x07, 0xa1, 0x20]], [0, 0x58, [4, 2, 24, 8]], [3840, 0x2f, []],
  ])
  assert.deepEqual(result.events.filter(e => e.status === 0xc0).map(e => [e.tick, e.data]), [[0, [0]]])
  const attacks = result.events.filter(e => e.status === 0x90 || e.status === 0x80)
  assert.deepEqual(attacks.map(e => [e.tick, e.status, e.data[0]]), [
    [480, 0x90, 60], [2400, 0x80, 60], [2400, 0x90, 60], [2880, 0x80, 60],
  ])
  assert.ok(attacks.filter(e => e.status === 0x90).every(e => e.data[1] > 0))
  const seconds = attacks.map(e => e.tick / 480 * .5)
  assert.deepEqual(seconds, [.5, 2.5, 2.5, 3])
  assert.deepEqual(scoreToPiano(score).notes.map(n => [n.start, n.end, n.midi]), [[.5, 2.5, 60], [2.5, 3, 60]])
  assert.deepEqual(score, before)
  const slower = parseMidi(scoreToMidi({ ...score, bpm: 60 }))
  assert.deepEqual(slower.events.find(e => e.type === 0x51)?.data, [0x0f, 0x42, 0x40])
  assert.deepEqual(slower.events.filter(e => e.status === 0x80 || e.status === 0x90), attacks)
})

test('VLQ handles long leading and trailing silence and big-endian track length exceeds one byte', () => {
  const measures: ScoreEvent[][] = Array.from({ length: 20 }, () => [])
  measures[17] = [{ tick: 272, ticks: 1, midi: 21, tieIn: false, tieOut: false }]
  const events = parseMidi(scoreToMidi({ bpm: 40, origin: 0, omittedNotes: 0, measures })).events
  assert.deepEqual(events.find(e => e.status === 0x90), {
    tick: 32640, status: 0x90, data: [21, 96], deltaBytes: [0x81, 0xff, 0x00],
  })
  assert.deepEqual(events.at(-1), {
    tick: 38400, status: 0xff, type: 0x2f, data: [], deltaBytes: [0xac, 0x08],
  })
  const dense: Score = { bpm: 240, origin: 0, omittedNotes: 0,
    measures: Array.from({ length: 8 }, (_, bar) => Array.from({ length: 16 }, (_, localTick) =>
      ({ tick: bar * 16 + localTick, ticks: 1, midi: 108, tieIn: false, tieOut: false }))),
  }
  const bytes = scoreToMidi(dense), parsed = parseMidi(bytes)
  assert.deepEqual([...bytes.slice(18, 22)], [0, 0, 4, 22])
  assert.equal(parsed.events.filter(e => e.status === 0x90).length, 128)
  assert.equal(parsed.events.at(-1)?.tick, 15360)
  assert.deepEqual(parsed.events.find(e => e.type === 0x51)?.data, [0x03, 0xd0, 0x90])
})

test('MIDI supports empty and silent scores and refuses invalid timing or pitch', () => {
  const empty: Score = { bpm: 120, origin: 0, omittedNotes: 0, measures: [] }
  assert.equal(parseMidi(scoreToMidi(empty)).events.at(-1)?.tick, 0)
  const silent = parseMidi(scoreToMidi({ ...empty, measures: [[], []] }))
  assert.equal(silent.events.at(-1)?.tick, 3840)
  assert.equal(silent.events.some(e => e.status === 0x90), false)
  for (const bpm of [0, NaN, 241]) assert.throws(() => scoreToMidi({ ...empty, bpm }), RangeError)
  const valid: ScoreEvent = { tick: 0, ticks: 4, midi: 60, tieIn: false, tieOut: false }
  for (const patch of [{ tick: -.5 }, { tick: .5 }, { ticks: 0 }, { ticks: 17 }, { midi: 109 }])
    assert.throws(() => scoreToMidi({ ...empty, measures: [[{ ...valid, ...patch }]] }), RangeError)
  assert.throws(() => scoreToMidi({ ...empty, measures: [[valid, { ...valid, tick: 2 }]] }), RangeError)
})
