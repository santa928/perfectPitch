import type { PianoNote } from '../analysis/notes.ts'

const TARGET_SAMPLE_RATE = 22050
const MAX_DURATION_SECONDS = 60
const TIMEOUT_MS = 60000

export type TranscriptionStage = 'loading' | 'analyzing' | 'notes'

export type TranscriptionProgress = {
  stage: TranscriptionStage
  progress?: number
}

export type TranscriptionErrorCode =
  | 'invalid-input'
  | 'unsupported'
  | 'aborted'
  | 'worker'
  | 'timeout'
  | 'invalid-output'

export type TranscriptionWorker = {
  onmessage: ((event: MessageEvent) => void) | null
  onerror: ((event: ErrorEvent) => void) | null
  postMessage(message: Record<string, unknown>, transfer: Transferable[]): void
  terminate(): void
}

export type TranscriptionRuntime = {
  createWorker(): TranscriptionWorker
  resample(
    samples: Float32Array,
    sourceRate: number,
    targetRate: number,
    signal: AbortSignal,
  ): Promise<Float32Array>
  assetUrls(): { modelUrl: string; wasmDirectoryUrl: string }
  setTimer(callback: () => void, milliseconds: number): number
  clearTimer(timer: number): void
}

export type TranscriptionOptions = {
  signal?: AbortSignal
  onProgress?(event: TranscriptionProgress): void
  runtime?: TranscriptionRuntime
}

type WorkerOutput =
  | { type: 'progress'; stage: TranscriptionStage; progress?: number }
  | { type: 'done'; notes: PianoNote[] }
  | { type: 'error'; message: string }

/** UIが再試行と入力エラーを区別できる採譜エラー。 */
export class TranscriptionError extends Error {
  readonly code: TranscriptionErrorCode

  constructor(
    code: TranscriptionErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options)
    this.name = 'TranscriptionError'
    this.code = code
  }
}

function aborted(cause?: unknown): TranscriptionError {
  return new TranscriptionError('aborted', '再採譜を中止しました。', { cause })
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) throw aborted(signal.reason)
}

function validateInput(samples: Float32Array, sampleRate: number): number {
  if (!Number.isFinite(sampleRate) || sampleRate <= 0 || samples.length === 0) {
    throw new TranscriptionError(
      'invalid-input',
      '再採譜する音声のsample rateまたは長さが不正です。',
    )
  }
  const duration = samples.length / sampleRate
  if (!Number.isFinite(duration) || duration > MAX_DURATION_SECONDS) {
    throw new TranscriptionError(
      'invalid-input',
      '再採譜できる音声は60秒以下です。',
    )
  }
  for (const sample of samples) {
    if (!Number.isFinite(sample)) {
      throw new TranscriptionError(
        'invalid-input',
        '音声PCMに不正な値があります。',
      )
    }
  }
  return duration
}

function validateProgress(message: WorkerOutput): TranscriptionProgress | null {
  if (message.type !== 'progress') return null
  if (!['loading', 'analyzing', 'notes'].includes(message.stage)) return null
  if (
    message.progress !== undefined &&
    (!Number.isFinite(message.progress) ||
      message.progress < 0 ||
      message.progress > 1)
  ) {
    return null
  }
  return message.progress === undefined
    ? { stage: message.stage }
    : { stage: message.stage, progress: message.progress }
}

function validateNotes(notes: PianoNote[], duration: number): PianoNote[] {
  if (!Array.isArray(notes)) {
    throw new TranscriptionError('invalid-output', '再採譜結果が不正です。')
  }
  for (const note of notes) {
    if (
      !Number.isFinite(note.start) ||
      !Number.isFinite(note.end) ||
      !Number.isInteger(note.midi) ||
      note.midi < 21 ||
      note.midi > 108 ||
      note.start < 0 ||
      note.end <= note.start ||
      note.end > duration + 1e-6 ||
      !Array.isArray(note.contour) ||
      note.contour.length !== 1 ||
      !Number.isFinite(note.contour[0]?.t) ||
      !Number.isFinite(note.contour[0]?.midi)
    ) {
      throw new TranscriptionError('invalid-output', '再採譜結果が不正です。')
    }
  }
  return notes
}

async function resampleInBrowser(
  samples: Float32Array,
  sourceRate: number,
  targetRate: number,
  signal: AbortSignal,
): Promise<Float32Array> {
  throwIfAborted(signal)
  if (sourceRate === targetRate) return samples.slice()
  const outputLength = Math.max(
    1,
    Math.round((samples.length * targetRate) / sourceRate),
  )
  const context = new OfflineAudioContext(1, outputLength, targetRate)
  const input = context.createBuffer(1, samples.length, sourceRate)
  input.copyToChannel(new Float32Array(samples), 0)
  const source = context.createBufferSource()
  source.buffer = input
  source.connect(context.destination)
  source.start()
  const rendered = await context.startRendering()
  throwIfAborted(signal)
  return rendered.getChannelData(0).slice()
}

function browserRuntime(): TranscriptionRuntime {
  if (
    typeof Worker === 'undefined' ||
    typeof OfflineAudioContext === 'undefined' ||
    typeof location === 'undefined'
  ) {
    throw new TranscriptionError(
      'unsupported',
      'このブラウザは端末内再採譜に対応していません。',
    )
  }

  return {
    createWorker: () =>
      new Worker(new URL('./transcription-worker.ts', import.meta.url), {
        type: 'module',
      }),
    resample: resampleInBrowser,
    assetUrls: () => {
      const base = new URL(import.meta.env.BASE_URL, location.href)
      return {
        modelUrl: new URL('models/basic-pitch.onnx', base).href,
        wasmDirectoryUrl: new URL('runtime/', base).href,
      }
    },
    setTimer: (callback, milliseconds) =>
      globalThis.setTimeout(callback, milliseconds),
    clearTimer: (timer) => globalThis.clearTimeout(timer),
  }
}

function runWorker(
  worker: TranscriptionWorker,
  samples: Float32Array,
  duration: number,
  runtime: TranscriptionRuntime,
  signal: AbortSignal,
  onProgress?: (event: TranscriptionProgress) => void,
): Promise<PianoNote[]> {
  return new Promise<PianoNote[]>((resolve, reject) => {
    let settled = false
    let timer: number | null = null
    const cleanup = (): void => {
      if (timer !== null) runtime.clearTimer(timer)
      signal.removeEventListener('abort', handleAbort)
      worker.onmessage = null
      worker.onerror = null
      worker.terminate()
    }
    const finish = (
      outcome: { notes: PianoNote[] } | { error: TranscriptionError },
    ): void => {
      if (settled) return
      settled = true
      cleanup()
      if ('error' in outcome) reject(outcome.error)
      else resolve(outcome.notes)
    }
    const handleAbort = (): void => finish({ error: aborted(signal.reason) })

    worker.onmessage = (event: MessageEvent<unknown>): void => {
      if (settled) return
      if (
        !event.data ||
        typeof event.data !== 'object' ||
        !('type' in event.data)
      ) {
        finish({
          error: new TranscriptionError(
            'invalid-output',
            '再採譜Workerから不正な応答を受け取りました。',
          ),
        })
        return
      }
      const message = event.data as WorkerOutput
      const progress = validateProgress(message)
      if (progress) {
        onProgress?.(progress)
        return
      }
      if (message.type === 'error') {
        finish({
          error: new TranscriptionError(
            'worker',
            `${message.message} 再試行できます。`,
          ),
        })
        return
      }
      if (message.type !== 'done') {
        finish({
          error: new TranscriptionError(
            'invalid-output',
            '再採譜Workerから不正な応答を受け取りました。',
          ),
        })
        return
      }
      try {
        finish({ notes: validateNotes(message.notes, duration) })
      } catch (error) {
        finish({
          error:
            error instanceof TranscriptionError
              ? error
              : new TranscriptionError('invalid-output', '再採譜結果が不正です。'),
        })
      }
    }
    worker.onerror = (event: ErrorEvent): void => {
      finish({
        error: new TranscriptionError(
          'worker',
          `${event.message || '端末内モデルを実行できませんでした。'} 再試行できます。`,
        ),
      })
    }
    signal.addEventListener('abort', handleAbort, { once: true })
    timer = runtime.setTimer(
      () =>
        finish({
          error: new TranscriptionError(
            'timeout',
            '端末内モデルの応答がありません。再試行できます。',
          ),
        }),
      TIMEOUT_MS,
    )

    try {
      const urls = runtime.assetUrls()
      worker.postMessage(
        {
          type: 'transcribe',
          samples,
          sampleRate: TARGET_SAMPLE_RATE,
          duration,
          ...urls,
        },
        [samples.buffer],
      )
    } catch (error) {
      finish({
        error: new TranscriptionError(
          'worker',
          '端末内モデルを開始できませんでした。再試行できます。',
          { cause: error },
        ),
      })
    }
  })
}

/**
 * 元PCMを変更せず、任意操作時だけ端末内Workerで単音メロディを再採譜する。
 */
export async function transcribeMelody(
  samples: Float32Array,
  sampleRate: number,
  options: TranscriptionOptions = {},
): Promise<PianoNote[]> {
  const duration = validateInput(samples, sampleRate)
  const signal = options.signal ?? new AbortController().signal
  throwIfAborted(signal)
  const runtime = options.runtime ?? browserRuntime()
  let resampled: Float32Array
  try {
    resampled = await runtime.resample(
      samples.slice(),
      sampleRate,
      TARGET_SAMPLE_RATE,
      signal,
    )
  } catch (error) {
    if (signal.aborted || (error instanceof Error && error.name === 'AbortError')) {
      throw aborted(error)
    }
    throw new TranscriptionError(
      'worker',
      '音声を端末内モデル用に準備できませんでした。再試行できます。',
      { cause: error },
    )
  }
  throwIfAborted(signal)
  if (
    resampled.length === 0 ||
    resampled.some((sample) => !Number.isFinite(sample))
  ) {
    throw new TranscriptionError(
      'invalid-input',
      '再標本化後の音声PCMが不正です。',
    )
  }
  let worker: TranscriptionWorker
  try {
    worker = runtime.createWorker()
  } catch (error) {
    throw new TranscriptionError(
      'worker',
      '端末内モデルを起動できませんでした。再試行できます。',
      { cause: error },
    )
  }
  return runWorker(
    worker,
    resampled,
    duration,
    runtime,
    signal,
    options.onProgress,
  )
}
