import type * as Ort from 'onnxruntime-web/wasm'
import {
  decodeModelMonophonic,
  type ModelActivity,
} from '../analysis/model-notes.ts'
import type { PianoNote } from '../analysis/notes.ts'

const MODEL_SAMPLE_RATE = 22050
const WINDOW_SAMPLES = 43844
const WINDOW_HOP = 36164
const INPUT_PADDING = 3840
const MODEL_FRAMES = 172
const EDGE_FRAMES = 15
const NOTE_BINS = 88
const INPUT_NAME = 'serving_default_input_2:0'
const FRAME_OUTPUT = 'StatefulPartitionedCall:1'
const ONSET_OUTPUT = 'StatefulPartitionedCall:2'

type OrtModule = typeof import('onnxruntime-web/wasm')

type WorkerInput = {
  type: 'transcribe'
  samples: Float32Array
  sampleRate: number
  duration: number
  modelUrl: string
  wasmDirectoryUrl: string
}

type WorkerOutput =
  | { type: 'progress'; stage: 'loading' | 'analyzing' | 'notes'; progress?: number }
  | { type: 'done'; notes: PianoNote[] }
  | { type: 'error'; message: string }

type WorkerScope = {
  location: Location
  onmessage: ((event: MessageEvent<WorkerInput>) => void) | null
  postMessage(message: WorkerOutput): void
}

const workerScope = globalThis as unknown as WorkerScope

function validateMessage(message: WorkerInput): void {
  if (
    message.type !== 'transcribe' ||
    !(message.samples instanceof Float32Array) ||
    message.sampleRate !== MODEL_SAMPLE_RATE ||
    !Number.isFinite(message.duration) ||
    message.duration <= 0 ||
    message.duration > 60 ||
    message.samples.length === 0 ||
    message.samples.some((sample) => !Number.isFinite(sample))
  ) {
    throw new Error('再採譜する音声が不正です。')
  }
  const model = new URL(message.modelUrl)
  const wasm = new URL(message.wasmDirectoryUrl)
  if (
    model.origin !== workerScope.location.origin ||
    wasm.origin !== workerScope.location.origin
  ) {
    throw new Error('端末内モデルの配信元が不正です。')
  }
}

function outputRows(
  output: Ort.InferenceSession.OnnxValueMapType,
  name: string,
  width: number,
): Float32Array {
  const tensor = output[name]
  if (
    !tensor ||
    !(tensor.data instanceof Float32Array) ||
    tensor.data.length < MODEL_FRAMES * width
  ) {
    throw new Error('端末内モデルの出力形式が一致しません。')
  }
  return tensor.data
}

/** 公式窓仕様で推論し、固定decoderが使う88鍵活動だけを保持する。 */
async function inferActivity(
  samples: Float32Array,
  duration: number,
  session: Ort.InferenceSession,
  ort: OrtModule,
): Promise<ModelActivity> {
  const originalFrameCount = Math.floor(
    (samples.length * 86) / MODEL_SAMPLE_RATE,
  )
  if (originalFrameCount === 0) return { frames: [], onsets: [], duration }
  const padded = new Float32Array(samples.length + INPUT_PADDING)
  padded.set(samples, INPUT_PADDING)
  const frames: number[][] = []
  const onsets: number[][] = []

  for (let start = 0; start < padded.length; start += WINDOW_HOP) {
    const values = new Float32Array(WINDOW_SAMPLES)
    values.set(padded.subarray(start, start + WINDOW_SAMPLES))
    const input = new ort.Tensor('float32', values, [1, WINDOW_SAMPLES, 1])
    let output: Ort.InferenceSession.OnnxValueMapType | null = null
    try {
      output = await session.run({ [INPUT_NAME]: input })
      const frameValues = outputRows(output, FRAME_OUTPUT, NOTE_BINS)
      const onsetValues = outputRows(output, ONSET_OUTPUT, NOTE_BINS)
      for (
        let frame = EDGE_FRAMES;
        frame < MODEL_FRAMES - EDGE_FRAMES &&
        frames.length < originalFrameCount;
        frame += 1
      ) {
        const offset = frame * NOTE_BINS
        frames.push(
          Array.from(frameValues.subarray(offset, offset + NOTE_BINS)),
        )
        onsets.push(
          Array.from(onsetValues.subarray(offset, offset + NOTE_BINS)),
        )
      }
    } finally {
      input.dispose()
      if (output) {
        for (const tensor of new Set(Object.values(output))) tensor.dispose()
      }
    }
    workerScope.postMessage({
      type: 'progress',
      stage: 'analyzing',
      progress: Math.min(1, (start + WINDOW_HOP) / padded.length),
    })
  }

  return { frames, onsets, duration }
}

function failureMessage(error: unknown): string {
  const detail = error instanceof Error ? error.message : String(error)
  if (/memory|allocation|out of memory|oom/i.test(detail)) {
    return '端末のメモリが不足し、再採譜できませんでした。'
  }
  return detail.startsWith('再採譜') || detail.startsWith('端末内')
    ? detail
    : '端末内モデルを実行できませんでした。'
}

/** 1回の要求だけを実行し、モデルsessionを応答前に必ず解放する。 */
async function transcribe(message: WorkerInput): Promise<void> {
  let session: Ort.InferenceSession | null = null
  try {
    validateMessage(message)
    workerScope.postMessage({ type: 'progress', stage: 'loading' })
    const runtimeUrl = new URL(
      'ort.wasm.min.mjs',
      message.wasmDirectoryUrl,
    ).href
    const ort = (await import(/* @vite-ignore */ runtimeUrl)) as OrtModule
    ort.env.wasm.wasmPaths = message.wasmDirectoryUrl
    ort.env.wasm.numThreads = 1
    session = await ort.InferenceSession.create(message.modelUrl, {
      executionProviders: ['wasm'],
      graphOptimizationLevel: 'all',
    })
    const activity = await inferActivity(
      message.samples,
      message.duration,
      session,
      ort,
    )
    workerScope.postMessage({ type: 'progress', stage: 'notes' })
    const notes = decodeModelMonophonic(activity)
    await session.release()
    session = null
    workerScope.postMessage({ type: 'done', notes })
  } catch (error) {
    workerScope.postMessage({ type: 'error', message: failureMessage(error) })
  } finally {
    if (session) {
      try {
        await session.release()
      } catch {
        // Workerは呼び出しごとに破棄される。一次エラーを優先する。
      }
    }
  }
}

workerScope.onmessage = (event: MessageEvent<WorkerInput>): void => {
  void transcribe(event.data)
}
