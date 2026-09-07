import assert from 'node:assert/strict'
import test from 'node:test'
import {
  transcribeMelody,
  TranscriptionError,
  type TranscriptionProgress,
  type TranscriptionRuntime,
  type TranscriptionWorker,
} from '../src/audio/transcription.ts'
import type { PianoNote } from '../src/analysis/notes.ts'

class FakeWorker {
  onmessage: ((event: MessageEvent) => void) | null = null
  onerror: ((event: ErrorEvent) => void) | null = null
  terminated = false
  posted: Record<string, unknown> | null = null
  respond = true
  readonly postedPromise: Promise<void>
  private markPosted!: () => void

  constructor() {
    this.postedPromise = new Promise((resolve) => {
      this.markPosted = resolve
    })
  }

  postMessage(message: Record<string, unknown>, transfer: Transferable[]): void {
    this.posted = structuredClone(message, { transfer })
    this.markPosted()
    if (!this.respond) return
    queueMicrotask(() => {
      this.emit({ type: 'progress', stage: 'loading' })
      this.emit({ type: 'progress', stage: 'analyzing', progress: 0.5 })
      this.emit({ type: 'progress', stage: 'notes' })
      this.emit({
        type: 'done',
        notes: [
          {
            start: 0,
            end: 0.2,
            midi: 60,
            contour: [{ t: 0, midi: 60 }],
          },
        ],
      })
    })
  }

  terminate(): void {
    this.terminated = true
  }

  emit(data: unknown): void {
    this.onmessage?.(new MessageEvent('message', { data }))
  }
}

type RuntimeFixture = {
  runtime: TranscriptionRuntime
  workers: FakeWorker[]
  sourceCopies: Float32Array[]
  sourceRates: number[]
  targetRates: number[]
  triggerTimeout(): void
  clearedTimers: () => number
}

function runtimeFixture(
  options: { respond?: boolean; workerError?: unknown } = {},
): RuntimeFixture {
  const workers: FakeWorker[] = []
  const sourceCopies: Float32Array[] = []
  const sourceRates: number[] = []
  const targetRates: number[] = []
  let timeoutCallback: (() => void) | null = null
  let clearCount = 0
  return {
    workers,
    sourceCopies,
    sourceRates,
    targetRates,
    triggerTimeout: () => timeoutCallback?.(),
    clearedTimers: () => clearCount,
    runtime: {
      createWorker: () => {
        if (options.workerError) throw options.workerError
        const worker = new FakeWorker()
        worker.respond = options.respond ?? true
        workers.push(worker)
        return worker as unknown as TranscriptionWorker
      },
      resample: async (samples, sourceRate, targetRate) => {
        sourceCopies.push(samples)
        sourceRates.push(sourceRate)
        targetRates.push(targetRate)
        return new Float32Array([0.1, -0.2, 0.3])
      },
      assetUrls: () => ({
        modelUrl: 'https://example.test/perfectPitch/models/basic-pitch.onnx',
        wasmDirectoryUrl: 'https://example.test/perfectPitch/runtime/',
      }),
      setTimer: (callback) => {
        timeoutCallback = callback
        return 7
      },
      clearTimer: (timer) => {
        assert.equal(timer, 7)
        clearCount += 1
        timeoutCallback = null
      },
    },
  }
}

test('48 kHz PCMのコピーだけを22050 Hzへ変換し、Worker結果と段階進捗を返す', async () => {
  const fixture = runtimeFixture()
  const samples = new Float32Array(48000)
  samples.set([0.25, -0.5, 0.75])
  const original = samples.slice()
  const progress: TranscriptionProgress[] = []

  const notes = await transcribeMelody(samples, 48000, {
    runtime: fixture.runtime,
    onProgress: (event) => progress.push(event),
  })

  assert.deepEqual(samples, original)
  assert.notEqual(fixture.sourceCopies[0], samples)
  assert.deepEqual(fixture.sourceCopies[0], original)
  assert.deepEqual(fixture.sourceRates, [48000])
  assert.deepEqual(fixture.targetRates, [22050])
  assert.deepEqual(notes, [
    {
      start: 0,
      end: 0.2,
      midi: 60,
      contour: [{ t: 0, midi: 60 }],
    },
  ] satisfies PianoNote[])
  assert.deepEqual(progress, [
    { stage: 'loading' },
    { stage: 'analyzing', progress: 0.5 },
    { stage: 'notes' },
  ])
  assert.equal(fixture.workers[0].terminated, true)
  assert.equal(fixture.clearedTimers(), 1)
  assert.deepEqual(
    {
      modelUrl: fixture.workers[0].posted?.modelUrl,
      wasmDirectoryUrl: fixture.workers[0].posted?.wasmDirectoryUrl,
      sampleRate: fixture.workers[0].posted?.sampleRate,
    },
    {
      modelUrl: 'https://example.test/perfectPitch/models/basic-pitch.onnx',
      wasmDirectoryUrl: 'https://example.test/perfectPitch/runtime/',
      sampleRate: 22050,
    },
  )
})

test('60秒超過・不正sample rate・非finite PCMはWorker起動前に拒否する', async () => {
  const cases: Array<[Float32Array, number]> = [
    [new Float32Array(61), 1],
    [new Float32Array([0]), 0],
    [new Float32Array([Number.NaN]), 48000],
  ]

  for (const [samples, sampleRate] of cases) {
    const fixture = runtimeFixture()
    await assert.rejects(
      transcribeMelody(samples, sampleRate, { runtime: fixture.runtime }),
      (error: unknown) =>
        error instanceof TranscriptionError && error.code === 'invalid-input',
    )
    assert.equal(fixture.workers.length, 0)
    assert.equal(fixture.sourceCopies.length, 0)
  }
})

test('中止時にWorkerとtimerを解放し、遅い結果を返さない', async () => {
  const fixture = runtimeFixture({ respond: false })
  const controller = new AbortController()
  const transcription = transcribeMelody(new Float32Array([0.1]), 48000, {
    runtime: fixture.runtime,
    signal: controller.signal,
  })
  while (!fixture.workers[0]) await Promise.resolve()
  await fixture.workers[0].postedPromise
  controller.abort()

  await assert.rejects(
    transcription,
    (error: unknown) =>
      error instanceof TranscriptionError && error.code === 'aborted',
  )
  assert.equal(fixture.workers[0].terminated, true)
  assert.equal(fixture.clearedTimers(), 1)
  fixture.workers[0].emit({ type: 'done', notes: [] })
})

test('60秒の応答timeoutでWorkerを終了し再試行可能な失敗を返す', async () => {
  const fixture = runtimeFixture({ respond: false })
  const transcription = transcribeMelody(new Float32Array([0.1]), 48000, {
    runtime: fixture.runtime,
  })
  while (!fixture.workers[0]) await Promise.resolve()
  await fixture.workers[0].postedPromise
  fixture.triggerTimeout()

  await assert.rejects(
    transcription,
    (error: unknown) =>
      error instanceof TranscriptionError &&
      error.code === 'timeout' &&
      error.message.includes('再試行'),
  )
  assert.equal(fixture.workers[0].terminated, true)
  assert.equal(fixture.clearedTimers(), 1)
})

test('Workerを起動できない端末でも日本語の再試行可能エラーを返す', async () => {
  const fixture = runtimeFixture({ workerError: new Error('out of memory') })

  await assert.rejects(
    transcribeMelody(new Float32Array([0.1]), 48000, {
      runtime: fixture.runtime,
    }),
    (error: unknown) =>
      error instanceof TranscriptionError &&
      error.code === 'worker' &&
      error.message.includes('再試行'),
  )
})

test('Workerの不正応答をtimeoutまで待たず拒否して解放する', async () => {
  const fixture = runtimeFixture({ respond: false })
  const transcription = transcribeMelody(new Float32Array([0.1]), 48000, {
    runtime: fixture.runtime,
  })
  while (!fixture.workers[0]) await Promise.resolve()
  await fixture.workers[0].postedPromise
  fixture.workers[0].emit(null)

  await assert.rejects(
    transcription,
    (error: unknown) =>
      error instanceof TranscriptionError && error.code === 'invalid-output',
  )
  assert.equal(fixture.workers[0].terminated, true)
  assert.equal(fixture.clearedTimers(), 1)
})
