import assert from 'node:assert/strict'
import test from 'node:test'
import {
  buildAudioConstraints,
  CaptureError,
  CaptureSession,
  reanalyze,
  type CaptureRuntime,
} from '../src/audio/capture.ts'
import type { PitchFrame } from '../src/analysis/pipeline.ts'

const voicedFrame: PitchFrame = {
  t: 0.02,
  frequency: 220,
  midi: 57,
  rms: 0.1,
  periodicity: 0.9,
  state: 'voiced',
}

class FakeTrack extends EventTarget {
  stopCount = 0

  stop(): void {
    this.stopCount += 1
  }

  getSettings(): MediaTrackSettings {
    return {
      sampleRate: 48000,
      noiseSuppression: true,
      echoCancellation: true,
      autoGainControl: false,
    }
  }
}

class FakePort extends EventTarget {
  onmessage: ((event: MessageEvent) => void) | null = null
  readonly postedTypes: string[] = []

  postMessage(message: { type: string }): void {
    this.postedTypes.push(message.type)
    if (message.type === 'stop')
      queueMicrotask(() => this.emit({ type: 'stopped' }))
  }

  start(): void {}

  close(): void {}

  emit(data: unknown): void {
    this.onmessage?.(new MessageEvent('message', { data }))
  }
}

class FakeWorkletNode {
  readonly port = new FakePort()
  onprocessorerror: (() => void) | null = null
  disconnected = false

  connect(): void {}

  disconnect(): void {
    this.disconnected = true
  }
}

class FakeSourceNode {
  disconnected = false

  connect(): void {}

  disconnect(): void {
    this.disconnected = true
  }
}

class FakeAudioContext extends EventTarget {
  readonly sampleRate = 48000
  state: AudioContextState = 'running'
  readonly audioWorklet = {
    addModule: async (_url: string): Promise<void> => {},
  }
  readonly source = new FakeSourceNode()
  closeCount = 0
  resumeCount = 0

  constructor() {
    super()
  }

  createMediaStreamSource(): FakeSourceNode {
    return this.source
  }

  async resume(): Promise<void> {
    this.resumeCount += 1
    this.state = 'running'
  }

  async close(): Promise<void> {
    this.closeCount += 1
    this.state = 'closed'
  }
}

class FakeWorker {
  onmessage: ((event: MessageEvent) => void) | null = null
  onerror: ((event: ErrorEvent) => void) | null = null
  terminated = false
  respondToReanalysis = true

  postMessage(
    message: { type: string; samples?: Float32Array },
    transfer: Transferable[] = [],
  ): void {
    const cloned = structuredClone(message, { transfer })
    if (cloned.type === 'chunk')
      queueMicrotask(() => this.emit({ type: 'frames', frames: [voicedFrame] }))
    if (cloned.type === 'reanalyze' && this.respondToReanalysis) {
      queueMicrotask(() => this.emit({ type: 'done', frames: [voicedFrame] }))
    }
  }

  terminate(): void {
    this.terminated = true
  }

  emit(data: unknown): void {
    this.onmessage?.(new MessageEvent('message', { data }))
  }
}

type RuntimeFixture = {
  runtime: CaptureRuntime
  track: FakeTrack
  context: FakeAudioContext
  node: FakeWorkletNode
  workers: FakeWorker[]
  constraints: MediaStreamConstraints[]
}

function runtimeFixture(
  getUserMedia?: (constraints: MediaStreamConstraints) => Promise<MediaStream>,
): RuntimeFixture {
  const track = new FakeTrack()
  const stream = {
    getAudioTracks: () => [track],
    getTracks: () => [track],
  } as unknown as MediaStream
  const context = new FakeAudioContext()
  const node = new FakeWorkletNode()
  const workers: FakeWorker[] = []
  const constraints: MediaStreamConstraints[] = []
  const runtime: CaptureRuntime = {
    supportsAudioWorklet: true,
    getSupportedConstraints: () => ({
      channelCount: true,
      noiseSuppression: true,
      echoCancellation: true,
      autoGainControl: true,
    }),
    getUserMedia: async (value) => {
      constraints.push(value)
      return getUserMedia ? getUserMedia(value) : stream
    },
    createAudioContext: () => context as unknown as AudioContext,
    createAudioWorkletNode: () => node as unknown as AudioWorkletNode,
    createWorker: () => {
      const worker = new FakeWorker()
      workers.push(worker)
      return worker as unknown as Worker
    },
    workletUrl: 'capture-worklet.js',
  }
  return { runtime, track, context, node, workers, constraints }
}

test('audio constraints request only supported voice processing settings', () => {
  assert.deepEqual(
    buildAudioConstraints({
      channelCount: true,
      noiseSuppression: true,
      echoCancellation: true,
    }),
    {
      audio: {
        channelCount: { ideal: 1 },
        noiseSuppression: { ideal: true },
        echoCancellation: { ideal: true },
      },
    },
  )
})

test('missing AudioWorklet support fails clearly before requesting a microphone', async () => {
  const fixture = runtimeFixture()
  fixture.runtime.supportsAudioWorklet = false
  const session = new CaptureSession('song', {}, fixture.runtime)

  await assert.rejects(
    session.start(),
    (error: unknown) =>
      error instanceof CaptureError && error.code === 'unsupported',
  )
  assert.equal(fixture.constraints.length, 0)
  assert.equal(fixture.context.resumeCount, 0)
})

test('permission denial does not use the overconstrained fallback', async () => {
  const fixture = runtimeFixture(async () => {
    throw new DOMException('denied', 'NotAllowedError')
  })
  const session = new CaptureSession('speech', {}, fixture.runtime)

  await assert.rejects(
    session.start(),
    (error: unknown) =>
      error instanceof CaptureError && error.code === 'permission',
  )
  assert.equal(fixture.constraints.length, 1)
  assert.equal(fixture.context.closeCount, 1)
})

test('cancel prevents a pending permission result from opening audio resources', async () => {
  let resolvePermission!: (stream: MediaStream) => void
  const permission = new Promise<MediaStream>((resolve) => {
    resolvePermission = resolve
  })
  const fixture = runtimeFixture(() => permission)
  const session = new CaptureSession('song', {}, fixture.runtime)

  const starting = session.start()
  session.cancel()
  const lateTrack = new FakeTrack()
  resolvePermission({
    getAudioTracks: () => [lateTrack],
    getTracks: () => [lateTrack],
  } as unknown as MediaStream)

  await assert.rejects(
    starting,
    (error: unknown) =>
      error instanceof CaptureError && error.code === 'cancelled',
  )
  assert.equal(lateTrack.stopCount, 1)
  assert.equal(fixture.context.resumeCount, 1)
  assert.equal(fixture.context.closeCount, 1)
  assert.equal(fixture.workers.length, 0)
})

test('audio context resumes before a pending microphone permission settles', async () => {
  let resolvePermission!: (stream: MediaStream) => void
  const permission = new Promise<MediaStream>((resolve) => {
    resolvePermission = resolve
  })
  const fixture = runtimeFixture(() => permission)
  fixture.context.state = 'suspended'
  const session = new CaptureSession('song', {}, fixture.runtime)

  const starting = session.start()
  assert.equal(fixture.context.resumeCount, 1)
  const track = new FakeTrack()
  resolvePermission({
    getAudioTracks: () => [track],
    getTracks: () => [track],
  } as unknown as MediaStream)
  await starting
  await session.stop()
})

test('overconstrained microphone request alone retries with basic audio constraints', async () => {
  const fixture = runtimeFixture(async (constraints) => {
    if (constraints.audio !== true)
      throw new DOMException('unsupported constraint', 'OverconstrainedError')
    return {
      getAudioTracks: () => [fixture.track],
      getTracks: () => [fixture.track],
    } as unknown as MediaStream
  })
  const session = new CaptureSession('speech', {}, fixture.runtime)

  await session.start()
  await session.stop()

  assert.equal(fixture.constraints.length, 2)
  assert.equal(fixture.constraints[1].audio, true)
})

test('stop returns capped PCM, applied settings and final worker reanalysis', async () => {
  const durations: number[] = []
  const liveFrames: PitchFrame[] = []
  const fixture = runtimeFixture()
  const session = new CaptureSession(
    'song',
    {
      onDuration: (duration) => durations.push(duration),
      onFrames: (frames) => liveFrames.push(...frames),
    },
    fixture.runtime,
  )
  await session.start()
  fixture.node.port.emit({
    type: 'samples',
    samples: Float32Array.from([0.1, 0.2, 0.3]),
  })
  await new Promise((resolve) => setTimeout(resolve, 0))

  const result = await session.stop()

  assert.deepEqual(result.samples, Float32Array.from([0.1, 0.2, 0.3]))
  assert.equal(result.sampleRate, 48000)
  assert.deepEqual(result.frames, [voicedFrame])
  assert.deepEqual(result.settings, fixture.track.getSettings())
  assert.deepEqual(durations, [3 / 48000])
  assert.deepEqual(liveFrames, [voicedFrame])
  assert.equal(fixture.track.stopCount, 1)
  assert.equal(fixture.context.closeCount, 1)
  assert.ok(fixture.workers.every((worker) => worker.terminated))
})

test('sample limit is the final worklet acknowledgement before auto-stop callback', async () => {
  let autoStops = 0
  const fixture = runtimeFixture()
  let session!: CaptureSession
  session = new CaptureSession(
    'song',
    {
      onAutoStop: () => {
        autoStops += 1
        void session.stop()
      },
    },
    fixture.runtime,
  )
  await session.start()
  fixture.node.port.emit({
    type: 'samples',
    samples: Float32Array.from([0.1, 0.2]),
  })

  fixture.node.port.emit({ type: 'limit', totalSamples: 2 })
  const result = await session.stop()

  assert.equal(autoStops, 1)
  assert.equal(result.samples.length, 2)
  assert.ok(!fixture.node.port.postedTypes.includes('stop'))
})

test('reanalyze transfers a copy and keeps the caller PCM attached', async () => {
  const originalWorker = Object.getOwnPropertyDescriptor(globalThis, 'Worker')
  const worker = new FakeWorker()
  Object.defineProperty(globalThis, 'Worker', {
    configurable: true,
    value: class {
      constructor() {
        return worker
      }
    },
  })
  const samples = Float32Array.from([0.1, 0.2, 0.3])

  try {
    const frames = await reanalyze(samples, 48000, 'song')
    assert.deepEqual(frames, [voicedFrame])
    assert.equal(samples.byteLength, 12)
    assert.deepEqual(samples, Float32Array.from([0.1, 0.2, 0.3]))
  } finally {
    if (originalWorker)
      Object.defineProperty(globalThis, 'Worker', originalWorker)
    else Reflect.deleteProperty(globalThis, 'Worker')
  }
})

test('muted and ended tracks report interruption and reject the capture', async (t) => {
  for (const eventName of ['mute', 'ended']) {
    await t.test(eventName, async () => {
      const failures: CaptureError[] = []
      const fixture = runtimeFixture()
      const session = new CaptureSession(
        'speech',
        { onFailure: (error) => failures.push(error) },
        fixture.runtime,
      )
      await session.start()

      fixture.track.dispatchEvent(new Event(eventName))
      await assert.rejects(
        session.stop(),
        (error: unknown) =>
          error instanceof CaptureError && error.code === 'interrupted',
      )

      assert.equal(failures.length, 1)
      assert.equal(failures[0].code, 'interrupted')
      assert.equal(fixture.track.stopCount, 1)
      assert.equal(fixture.context.closeCount, 1)
    })
  }
})

test('processor and worker errors reject without waiting for offline reanalysis', async (t) => {
  for (const boundary of ['worklet', 'worker'] as const) {
    await t.test(boundary, async () => {
      const failures: CaptureError[] = []
      const fixture = runtimeFixture()
      const session = new CaptureSession(
        'song',
        { onFailure: (error) => failures.push(error) },
        fixture.runtime,
      )
      await session.start()
      fixture.workers[0].respondToReanalysis = false

      if (boundary === 'worklet') fixture.node.onprocessorerror?.()
      else
        fixture.workers[0].onerror?.({
          message: 'worker crashed',
        } as ErrorEvent)

      await assert.rejects(
        session.stop(),
        (error: unknown) =>
          error instanceof CaptureError && error.code === boundary,
      )
      assert.equal(failures[0].code, boundary)
      assert.equal(fixture.context.closeCount, 1)
    })
  }
})

test('suspended audio fails stop instead of accepting potentially incomplete PCM', async () => {
  const fixture = runtimeFixture()
  const session = new CaptureSession('song', {}, fixture.runtime)
  await session.start()
  fixture.context.state = 'suspended'

  await assert.rejects(
    session.stop(),
    (error: unknown) => error instanceof CaptureError && error.code === 'stop',
  )
  assert.equal(fixture.track.stopCount, 1)
  assert.equal(fixture.context.closeCount, 1)
})

test('cancel rejects an offline reanalysis that is waiting on a worker', async () => {
  const fixture = runtimeFixture()
  const session = new CaptureSession('speech', {}, fixture.runtime)
  await session.start()
  fixture.workers[0].respondToReanalysis = false

  const stopping = session.stop()
  await new Promise((resolve) => setTimeout(resolve, 0))
  session.cancel()

  await assert.rejects(
    Promise.race([
      stopping,
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error('cancel did not settle stop')), 50),
      ),
    ]),
    (error: unknown) =>
      error instanceof CaptureError && error.code === 'cancelled',
  )
})
