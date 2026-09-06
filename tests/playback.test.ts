import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  parseSoundfont,
  rateForMidi,
  playbackPosition,
} from '../src/audio/playback-model.ts'

test('soundfont parser extracts data without executing remote JavaScript', () => {
  const data = parseSoundfont(
    'MIDI.Soundfont.piano = {"A4":"data:audio/mp3;base64,AAAA"};',
  )
  assert.equal(data.A4, 'data:audio/mp3;base64,AAAA')
  assert.throws(() => parseSoundfont('globalThis.compromised = true;'))
  assert.throws(() =>
    parseSoundfont('x = {"A4":"https://unexpected.invalid/"}'),
  )
})
test('fractional sample pitch preserves positive and negative 30 cents', () => {
  assert.ok(Math.abs(rateForMidi(69.3, 69) - 1.0174796921) < 1e-8)
  assert.ok(Math.abs(rateForMidi(68.7, 69) - 0.9828205985) < 1e-8)
  assert.equal(rateForMidi(69, 69), 1)
})
test('shared audio clock keeps offset and clamps scheduled and completed positions', () => {
  assert.equal(playbackPosition(9, 10, 2, 5), 2)
  assert.equal(playbackPosition(11.25, 10, 2, 5), 3.25)
  assert.equal(playbackPosition(18, 10, 2, 5), 5)
})
test('upstream SoundFont trailing comma remains data-only JSON compatible', () => {
  assert.equal(
    parseSoundfont(
      'MIDI.Soundfont.piano = {"A4":"data:audio/mp3;base64,AAAA",\n\n}',
    ).A4,
    'data:audio/mp3;base64,AAAA',
  )
})

import { VoicePlayer } from '../src/audio/player.ts'

/** Deferred browser operations expose cancellation boundaries without wall-clock waits. */
function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

/** Minimal AudioContext double: output scheduling is validated separately with real OfflineAudioContext. */
class PendingContext {
  static latest: PendingContext
  static resumeGate: ReturnType<typeof deferred<void>> | null = null
  state = 'suspended'
  currentTime = 0
  onstatechange: (() => void) | null = null
  createdSources = 0
  constructor() {
    PendingContext.latest = this
  }
  async resume() {
    if (PendingContext.resumeGate) await PendingContext.resumeGate.promise
    this.state = 'running'
  }
  async decodeAudioData() {
    return { duration: 0.1 }
  }
  createBufferSource() {
    this.createdSources++
    throw new Error('Must not schedule after interruption')
  }
  async close() {
    this.state = 'closed'
  }
}

test('stop while resume is unresolved prevents a later sample fetch', async () => {
  const originalContext = globalThis.AudioContext,
    originalFetch = globalThis.fetch
  const gate = deferred<void>()
  PendingContext.resumeGate = gate
  let requests = 0
  globalThis.AudioContext = PendingContext as unknown as typeof AudioContext
  globalThis.fetch = async () => {
    requests++
    throw new Error('Unexpected fetch')
  }
  const player = new VoicePlayer()
  try {
    const playing = player.play(new Float32Array(48000), 48000, [])
    player.stop()
    gate.resolve()
    assert.equal(await playing, false)
    assert.equal(requests, 0)
  } finally {
    player.dispose()
    PendingContext.resumeGate = null
    globalThis.AudioContext = originalContext
    globalThis.fetch = originalFetch
  }
})

test('context interruption while samples load invalidates scheduling and stale status', async () => {
  const originalContext = globalThis.AudioContext,
    originalFetch = globalThis.fetch
  globalThis.AudioContext = PendingContext as unknown as typeof AudioContext
  const response = deferred<Response>(),
    requested = deferred<void>()
  globalThis.fetch = async () => {
    requested.resolve()
    return response.promise
  }
  const player = new VoicePlayer(),
    statuses: string[] = []
  let interrupted = 0
  player.onStatus = (status) => statuses.push(status)
  player.onInterrupted = () => interrupted++
  try {
    const playing = player.play(new Float32Array(48000), 48000, [])
    await requested.promise
    const context = PendingContext.latest
    context.state = 'suspended'
    context.onstatechange?.()
    response.resolve(
      new Response(
        'MIDI.Soundfont.piano = {"A1":"data:audio/mp3;base64,AAAA","A2":"data:audio/mp3;base64,AAAA","A3":"data:audio/mp3;base64,AAAA","A4":"data:audio/mp3;base64,AAAA","A5":"data:audio/mp3;base64,AAAA"}',
      ),
    )
    assert.equal(await playing, false)
    assert.equal(interrupted, 1)
    assert.equal(context.createdSources, 0)
    assert.deepEqual(statuses, ['loading'])
  } finally {
    player.dispose()
    globalThis.AudioContext = originalContext
    globalThis.fetch = originalFetch
  }
})

test('stale load failure cannot overwrite a new piano retry status', async () => {
  const originalContext = globalThis.AudioContext,
    originalFetch = globalThis.fetch
  globalThis.AudioContext = PendingContext as unknown as typeof AudioContext
  let rejectOld!: (reason: Error) => void
  const oldResponse = new Promise<Response>((_, reject) => {
    rejectOld = reject
  })
  const oldRequested = deferred<void>(),
    newRequested = deferred<void>(),
    newResponse = deferred<Response>()
  let count = 0
  globalThis.fetch = async () => {
    if (++count === 1) {
      oldRequested.resolve()
      return oldResponse
    }
    newRequested.resolve()
    return newResponse.promise
  }
  const player = new VoicePlayer(),
    statuses: string[] = []
  player.onStatus = (status) => statuses.push(status)
  try {
    const oldPlay = player.play(new Float32Array(48000), 48000, [])
    await oldRequested.promise
    player.stop()
    const newPlay = player.play(new Float32Array(48000), 48000, [])
    await newRequested.promise
    rejectOld(new Error('Old network failure'))
    assert.equal(await oldPlay, false)
    assert.deepEqual(statuses, ['loading', 'loading'])
    newResponse.resolve(
      new Response(
        'MIDI.Soundfont.piano = {"A1":"data:audio/mp3;base64,AAAA","A2":"data:audio/mp3;base64,AAAA","A3":"data:audio/mp3;base64,AAAA","A4":"data:audio/mp3;base64,AAAA","A5":"data:audio/mp3;base64,AAAA"}',
      ),
    )
    assert.equal(await newPlay, true)
    assert.deepEqual(statuses, ['loading', 'loading', 'ready'])
  } finally {
    player.dispose()
    globalThis.AudioContext = originalContext
    globalThis.fetch = originalFetch
  }
})
