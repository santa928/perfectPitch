import { test } from 'node:test'
import assert from 'node:assert/strict'
import { VoicePlayer } from '../src/audio/player.ts'

/** AudioContext double records actual source scheduling without fetching an external soundfont. */
class ClockContext {
  static latest: ClockContext
  state = 'running'
  currentTime = 0
  destination = {}
  onstatechange: (() => void) | null = null
  starts: number[][] = []
  stops: (number | undefined)[] = []
  decodedMarkers: number[] = []
  constructor() { ClockContext.latest = this }
  async resume() {}
  async close() { this.state = 'closed' }
  createBuffer(channels: number, length: number, sampleRate: number) {
    const data = new Float32Array(length)
    return { length, sampleRate, duration: length / sampleRate, numberOfChannels: channels,
      getChannelData: () => data, copyToChannel: (source: Float32Array) => data.set(source) }
  }
  async decodeAudioData(bytes: ArrayBuffer) {
    this.decodedMarkers.push(new Uint8Array(bytes)[0])
    return this.createBuffer(1, 48000, 48000)
  }
  createBufferSource() {
    return { buffer: null, onended: null,
      playbackRate: { setValueAtTime() {}, linearRampToValueAtTime() {} },
      connect: (node: unknown) => node, disconnect() {},
      start: (...args: number[]) => this.starts.push(args),
      stop: (when?: number) => this.stops.push(when) }
  }
  createGain() {
    return { gain: { setValueAtTime() {}, linearRampToValueAtTime() {} },
      connect() {}, disconnect() {} }
  }
}

test('derived playback duration governs seeking, position and end beyond the original PCM', async (t) => {
  const originalContext = globalThis.AudioContext
  globalThis.AudioContext = ClockContext as unknown as typeof AudioContext
  t.after(() => { globalThis.AudioContext = originalContext })
  t.mock.method(globalThis, 'fetch', async () => new Response('MIDI.Soundfont.piano = ' + JSON.stringify(
    Object.fromEntries(['A1', 'A2', 'A3', 'A4', 'A5'].map((name) => [name, 'data:audio/mp3;base64,AAAA'])),
  ) + ';'))
  const timers: { callback: () => void; delay: number }[] = []
  t.mock.method(globalThis, 'setTimeout', (callback: () => void, delay: number) => {
    timers.push({ callback, delay })
    return timers.length
  })
  t.mock.method(globalThis, 'clearTimeout', () => {})
  const player = new VoicePlayer()
  let ended = 0
  player.onEnded = () => ended++
  try {
    const note = { start: 0, end: 4, midi: 69, contour: [{ t: 0, midi: 69 }] }
    assert.equal(await player.play(new Float32Array(48000), 48000, [note], 2, 4), true)
    const context = ClockContext.latest
    assert.equal(player.position(), 2)
    context.currentTime = 1.04
    assert.equal(player.position(), 3)
    assert.equal(Math.round(timers.at(-1)!.delay), 2180)
    assert.ok(Math.abs(context.stops[0]! - 2.16) < 1e-8)
    context.currentTime = 2.1
    timers.at(-1)!.callback()
    assert.equal(player.position(), 4)
    assert.equal(ended, 1)
    assert.equal(await player.play(new Float32Array(48000), 48000, null, 0, 4), true)
    assert.equal(timers.at(-1)!.delay, 1060)
    context.currentTime += 2
    assert.equal(player.position(), 1)
  } finally { player.dispose() }
})

test('通常ピアノは使う鍵盤の音源だけをデコードし、次の鍵盤でも取得済みデータを再利用する', async (t) => {
  const originalContext = globalThis.AudioContext
  globalThis.AudioContext = ClockContext as unknown as typeof AudioContext
  t.after(() => { globalThis.AudioContext = originalContext })
  let requests = 0
  t.mock.method(globalThis, 'fetch', async () => {
    requests++
    return new Response('MIDI.Soundfont.piano = ' + JSON.stringify({
      A1: 'data:audio/mp3;base64,AAAA', A2: 'data:audio/mp3;base64,AAAA',
      A3: 'data:audio/mp3;base64,AAAA', A4: 'data:audio/mp3;base64,AAAA',
      A5: 'data:audio/mp3;base64,AAAA', C4: 'data:audio/mp3;base64,AQAA',
      Db4: 'data:audio/mp3;base64,AgAA',
    }) + ';')
  })
  const player = new VoicePlayer()
  try {
    const note = { start: 0, end: .5, midi: 60, contour: [] }
    await player.play(new Float32Array(48000), 48000, [note])
    assert.deepEqual(ClockContext.latest.decodedMarkers, [1])
    await player.play(new Float32Array(48000), 48000, [{ ...note, midi: 61 }])
    await player.play(new Float32Array(48000), 48000, [note])
    assert.equal(requests, 1)
    assert.deepEqual(ClockContext.latest.decodedMarkers, [1, 2])
  } finally { player.dispose() }
})

test('音源の一部が欠けても既存鍵盤を再生でき、失敗した鍵盤は再取得して試せる', async (t) => {
  const originalContext = globalThis.AudioContext
  globalThis.AudioContext = ClockContext as unknown as typeof AudioContext
  t.after(() => { globalThis.AudioContext = originalContext })
  let requests = 0
  t.mock.method(globalThis, 'fetch', async () => {
    requests++
    return new Response('MIDI.Soundfont.piano = ' + JSON.stringify({
      C4: 'data:audio/mp3;base64,AQAA',
      ...(requests > 1 ? { Db4: 'data:audio/mp3;base64,AgAA' } : {}),
    }) + ';')
  })
  const player = new VoicePlayer()
  const statuses: string[] = []
  player.onStatus = status => statuses.push(status)
  try {
    const note = { start: 0, end: .5, midi: 60, contour: [] }
    await player.play(new Float32Array(48000), 48000, [note])
    await assert.rejects(player.play(new Float32Array(48000), 48000, [{ ...note, midi: 61 }]), /必要なピアノ音/)
    assert.equal(statuses.at(-1), 'error')
    await player.play(new Float32Array(48000), 48000, [note])
    assert.equal(statuses.at(-1), 'ready')
    await player.play(new Float32Array(48000), 48000, [{ ...note, midi: 61 }])
    assert.equal(statuses.at(-1), 'ready')
    assert.equal(requests, 2)
    assert.deepEqual(ClockContext.latest.decodedMarkers, [1, 2])
  } finally { player.dispose() }
})

test('invalid derived duration is rejected before audio or network work', async (t) => {
  let audioCalls = 0
  const originalContext = globalThis.AudioContext
  globalThis.AudioContext = class { constructor() { audioCalls++ } } as unknown as typeof AudioContext
  t.after(() => { globalThis.AudioContext = originalContext })
  const player = new VoicePlayer()
  for (const duration of [NaN, Infinity, -1, 3_000_000])
    await assert.rejects(player.play(new Float32Array(48000), 48000, [], 0, duration), RangeError)
  assert.equal(audioCalls, 0)
})
