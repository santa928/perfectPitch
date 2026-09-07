import captureWorkletUrl from './capture-worklet.js?url'
import type { AnalysisMode, PitchFrame } from '../analysis/pipeline.ts'

const MAX_CAPTURE_SECONDS = 60
const WORKLET_CHUNK_SIZE = 1024
const STOP_ACK_TIMEOUT_MS = 1000
const ANALYSIS_TIMEOUT_MS = 60000

export type CaptureErrorCode =
  | 'unsupported'
  | 'permission'
  | 'cancelled'
  | 'interrupted'
  | 'worker'
  | 'worklet'
  | 'start'
  | 'stop'

export type CaptureCallbacks = {
  onFrames?(frames: PitchFrame[]): void
  onDuration?(seconds: number): void
  onFailure?(error: CaptureError): void
  onAutoStop?(): void
  onAnalysisProgress?(progress: number): void
}

export type CaptureResult = {
  samples: Float32Array
  sampleRate: number
  frames: PitchFrame[]
  settings: MediaTrackSettings
  /** PCM is complete, but derived pitch data must be retried. */
  analysisError?: string
  /** ファイル入力では冒頭の校正待ちを作らない。マイク録音は既定true。 */
  calibrate?: boolean
}

export type ReanalysisOptions = { calibrate?: boolean; signal?: AbortSignal }

/** ブラウザ境界を差し替え可能にする CaptureSession の実行環境。 */
export type CaptureRuntime = {
  supportsAudioWorklet: boolean
  getSupportedConstraints(): MediaTrackSupportedConstraints
  getUserMedia(constraints: MediaStreamConstraints): Promise<MediaStream>
  createAudioContext(): AudioContext
  createAudioWorkletNode(
    context: AudioContext,
    options: AudioWorkletNodeOptions,
  ): AudioWorkletNode
  createWorker(): Worker
  workletUrl: string
}

type WorkerOutput =
  | { type: 'frames'; frames: PitchFrame[] }
  | { type: 'done'; frames: PitchFrame[] }
  | { type: 'progress'; progress: number }
  | { type: 'error'; message: string }

type WorkletOutput =
  | { type: 'samples'; samples: Float32Array }
  | { type: 'stopped'; totalSamples: number }
  | { type: 'limit'; totalSamples: number }

type SessionState =
  | 'idle'
  | 'starting'
  | 'running'
  | 'stopping'
  | 'stopped'
  | 'cancelled'
  | 'failed'

/** 録音境界の失敗種別を UI が安定して判定できるエラー。 */
export class CaptureError extends Error {
  readonly code: CaptureErrorCode

  constructor(code: CaptureErrorCode, message: string, options?: ErrorOptions) {
    super(message, options)
    this.name = 'CaptureError'
    this.code = code
  }
}

/** 弱い基音をノイズ抑制で失わないよう、対応制約だけで mono 入力を要求する。 */
export function buildAudioConstraints(
  supported: MediaTrackSupportedConstraints,
): MediaStreamConstraints {
  const audio: MediaTrackConstraints = {}
  if (supported.channelCount) audio.channelCount = { ideal: 1 }
  if (supported.noiseSuppression) audio.noiseSuppression = { ideal: false }
  if (supported.echoCancellation) audio.echoCancellation = { ideal: true }
  if (supported.autoGainControl) audio.autoGainControl = { ideal: false }
  return { audio }
}

/** PCM のコピーを Worker へ渡し、呼び出し元の buffer を detach せずに再解析する。 */
export async function reanalyze(
  samples: Float32Array,
  sampleRate: number,
  mode: AnalysisMode,
  onProgress?: (progress: number) => void,
  options: ReanalysisOptions = {},
): Promise<PitchFrame[]> {
  if (options.signal?.aborted) throw new CaptureError('cancelled', '音声の分析を中止しました。')
  if (typeof Worker === 'undefined') {
    throw new CaptureError(
      'unsupported',
      'このブラウザは音声解析 Worker に対応していません。',
    )
  }
  const worker = createBrowserWorker()
  try {
    return await analyzeWithWorker(worker, samples, sampleRate, mode, undefined, onProgress, options)
  } finally {
    worker.terminate()
  }
}

/** AudioWorklet から PCM を収集し、ライブ解析と停止後の再解析を管理する。 */
export class CaptureSession {
  private readonly mode: AnalysisMode
  private readonly callbacks: CaptureCallbacks
  private readonly runtime: CaptureRuntime
  private state: SessionState = 'idle'
  private generation = 0
  private stream: MediaStream | null = null
  private track: MediaStreamTrack | null = null
  private context: AudioContext | null = null
  private source: MediaStreamAudioSourceNode | null = null
  private node: AudioWorkletNode | null = null
  private worker: Worker | null = null
  private chunks: Float32Array[] = []
  private totalSamples = 0
  private sampleRate = 0
  private maxSamples = 0
  private settings: MediaTrackSettings = {}
  private stopAck: (() => void) | null = null
  private stopPromise: Promise<CaptureResult> | null = null
  private result: CaptureResult | null = null
  private reanalysisResolve: ((frames: PitchFrame[]) => void) | null = null
  private reanalysisReject: ((error: CaptureError) => void) | null = null
  private failureReported = false
  private autoStopReported = false
  private audioGraphStopped = false
  private terminalError: CaptureError | null = null
  private workletStopped = false

  constructor(
    mode: AnalysisMode,
    callbacks: CaptureCallbacks = {},
    runtime: CaptureRuntime = browserRuntime(),
  ) {
    this.mode = mode
    this.callbacks = callbacks
    this.runtime = runtime
  }

  /** マイク許可、AudioWorklet、解析 Worker を順に開始する。 */
  async start(): Promise<void> {
    if (this.state !== 'idle')
      throw new CaptureError(
        'start',
        '録音セッションはすでに開始されています。',
      )
    if (!this.runtime.supportsAudioWorklet) {
      throw new CaptureError(
        'unsupported',
        'このブラウザは AudioWorklet 録音に対応していません。',
      )
    }

    this.state = 'starting'
    const generation = ++this.generation
    try {
      const context = this.runtime.createAudioContext()
      this.context = context
      this.sampleRate = context.sampleRate
      this.maxSamples = Math.round(context.sampleRate * MAX_CAPTURE_SECONDS)
      context.addEventListener('statechange', this.handleContextStateChange)
      const resumePromise = context.resume()
      const constraints = buildAudioConstraints(
        this.runtime.getSupportedConstraints(),
      )
      const streamPromise = this.requestStream(constraints)
      let stream: MediaStream
      try {
        ;[stream] = await Promise.all([streamPromise, resumePromise])
      } catch (error) {
        void streamPromise.then(stopStream, () => undefined)
        throw error
      }
      if (generation !== this.generation) {
        stopStream(stream)
        throw new CaptureError('cancelled', '録音開始はキャンセルされました。')
      }

      const track = stream.getAudioTracks()[0]
      if (!track) {
        stopStream(stream)
        throw new CaptureError(
          'start',
          '利用できるマイク音声トラックがありません。',
        )
      }
      this.stream = stream
      this.track = track
      this.settings = { ...track.getSettings() }
      track.addEventListener('ended', this.handleTrackInterruption)
      track.addEventListener('mute', this.handleTrackInterruption)

      await context.audioWorklet.addModule(this.runtime.workletUrl)
      this.assertCurrent(generation)

      const worker = this.runtime.createWorker()
      this.worker = worker
      worker.onmessage = this.handleWorkerMessage
      worker.onerror = this.handleWorkerError
      worker.postMessage({
        type: 'init',
        sampleRate: this.sampleRate,
        mode: this.mode,
      })

      const node = this.runtime.createAudioWorkletNode(context, {
        numberOfInputs: 1,
        numberOfOutputs: 0,
        channelCount: 1,
        processorOptions: {
          chunkSize: WORKLET_CHUNK_SIZE,
          maxSamples: this.maxSamples,
        },
      })
      this.node = node
      node.port.onmessage = this.handleWorkletMessage
      node.onprocessorerror = this.handleProcessorError
      this.source = context.createMediaStreamSource(stream)
      this.source.connect(node)
      this.state = 'running'
    } catch (error) {
      const captureError = normalizeStartError(error)
      await this.releaseResources()
      this.state = captureError.code === 'cancelled' ? 'cancelled' : 'failed'
      throw captureError
    }
  }

  /** 許可待ちを無効化し、開始済みなら非同期で全リソースを解放する。 */
  cancel(): void {
    if (this.state === 'cancelled' || this.state === 'stopped') return
    this.generation += 1
    this.state = 'cancelled'
    this.stopAck?.()
    this.stopAck = null
    this.reanalysisReject?.(
      new CaptureError('cancelled', '録音停止処理はキャンセルされました。'),
    )
    this.clearReanalysisCallbacks()
    if (this.stream || this.context || this.worker) void this.releaseResources()
  }

  /** Worklet の最終 flush を待ち、PCM と停止後再解析結果を返す。 */
  stop(): Promise<CaptureResult> {
    if (this.result) return Promise.resolve(this.result)
    if (this.stopPromise) return this.stopPromise
    if (this.state === 'cancelled') {
      return Promise.reject(
        new CaptureError(
          'cancelled',
          '録音セッションはキャンセルされています。',
        ),
      )
    }
    if (this.state !== 'running' && this.state !== 'stopping') {
      return Promise.reject(
        new CaptureError(
          'stop',
          '開始されていない録音セッションは停止できません。',
        ),
      )
    }
    this.state = 'stopping'
    this.stopPromise = this.finishStop(this.generation)
    return this.stopPromise
  }

  private readonly requestStream = async (
    constraints: MediaStreamConstraints,
  ): Promise<MediaStream> => {
    try {
      return await this.runtime.getUserMedia(constraints)
    } catch (error) {
      if (isOverconstrained(error))
        return this.runtime.getUserMedia({ audio: true })
      throw error
    }
  }

  private readonly handleTrackInterruption = (): void => {
    this.failAndStop(
      new CaptureError('interrupted', 'マイク入力が中断されました。'),
    )
  }

  private readonly handleContextStateChange = (): void => {
    const state = this.context?.state as string | undefined
    if (
      this.state === 'running' &&
      (state === 'suspended' || state === 'interrupted' || state === 'closed')
    ) {
      this.failAndStop(
        new CaptureError('interrupted', '音声処理が中断されました。'),
      )
    }
  }

  private readonly handleProcessorError = (): void => {
    this.failAndStop(
      new CaptureError('worklet', '録音処理でエラーが発生しました。'),
    )
  }

  private readonly handleWorkerError = (event: ErrorEvent): void => {
    const error = new CaptureError(
      'worker',
      event.message || '音程解析 Worker でエラーが発生しました。',
    )
    const reviewing = this.reanalysisReject !== null
    this.reanalysisReject?.(error)
    this.clearReanalysisCallbacks()
    if (!reviewing) this.failAndStop(error)
  }

  private readonly handleWorkerMessage = (
    event: MessageEvent<WorkerOutput>,
  ): void => {
    const message = event.data
    if (message.type === 'progress') {
      if (this.reanalysisResolve)
        callSafely(() => this.callbacks.onAnalysisProgress?.(message.progress))
      return
    }
    if (message.type === 'frames') {
      callSafely(() => this.callbacks.onFrames?.(message.frames))
      return
    }
    if (message.type === 'done') {
      this.reanalysisResolve?.(message.frames)
      this.clearReanalysisCallbacks()
      return
    }
    if (message.type === 'error') {
      const error = new CaptureError('worker', message.message)
      const reviewing = this.reanalysisReject !== null
      this.reanalysisReject?.(error)
      this.clearReanalysisCallbacks()
      if (!reviewing) this.failAndStop(error)
    }
  }

  private readonly handleWorkletMessage = (
    event: MessageEvent<WorkletOutput>,
  ): void => {
    const message = event.data
    if (message.type === 'samples') {
      this.acceptSamples(message.samples)
      return
    }
    if (message.type === 'stopped') {
      this.workletStopped = true
      this.stopAck?.()
      this.stopAck = null
      return
    }
    if (message.type === 'limit' && !this.autoStopReported) {
      this.workletStopped = true
      this.autoStopReported = true
      callSafely(() => this.callbacks.onAutoStop?.())
      void this.stop().catch((error) =>
        this.reportFailure(normalizeStopError(error)),
      )
    }
  }

  /** Worklet chunk を PCM 保持用と Worker 転送用に分離する。 */
  private acceptSamples(samples: Float32Array): void {
    if (this.state !== 'running' && this.state !== 'stopping') return
    const remaining = this.maxSamples - this.totalSamples
    if (remaining <= 0) return
    const kept =
      samples.length <= remaining ? samples : samples.slice(0, remaining)
    this.chunks.push(kept)
    this.totalSamples += kept.length
    callSafely(() =>
      this.callbacks.onDuration?.(this.totalSamples / this.sampleRate),
    )
    const analysisChunk = kept.slice()
    this.worker?.postMessage({ type: 'chunk', samples: analysisChunk }, [
      analysisChunk.buffer,
    ])
  }

  /** stop ack（suspended 時は待たない）後に最終再解析と解放を行う。 */
  private async finishStop(generation: number): Promise<CaptureResult> {
    try {
      await this.requestWorkletStop()
      if (generation !== this.generation)
        throw new CaptureError(
          'cancelled',
          '録音停止処理はキャンセルされました。',
        )
      const samples = joinChunks(this.chunks, this.totalSamples)
      this.stopTrackAndAudioGraph()
      if (this.terminalError) throw this.terminalError
      let frames: PitchFrame[] = []
      let analysisError: string | undefined
      try {
        if (this.worker) {
          frames = await analyzeWithWorker(
            this.worker,
            samples,
            this.sampleRate,
            this.mode,
            this.setReanalysisCallbacks,
          )
        }
      } catch (error) {
        if (error instanceof CaptureError && error.code === 'cancelled') throw error
        analysisError = error instanceof Error ? error.message : '音程を分析できませんでした。'
      }
      if (generation !== this.generation)
        throw new CaptureError(
          'cancelled',
          '録音停止処理はキャンセルされました。',
        )
      const result: CaptureResult = {
        samples,
        sampleRate: this.sampleRate,
        frames,
        settings: { ...this.settings },
        ...(analysisError ? { analysisError } : {}),
      }
      this.result = result
      this.state = 'stopped'
      return result
    } catch (error) {
      const captureError = normalizeStopError(error)
      this.state = captureError.code === 'cancelled' ? 'cancelled' : 'failed'
      throw captureError
    } finally {
      await this.releaseResources()
    }
  }

  private async requestWorkletStop(): Promise<void> {
    const node = this.node
    if (!node || this.workletStopped) return
    if (this.context?.state === 'suspended') {
      node.port.postMessage({ type: 'stop' })
      throw new CaptureError(
        'stop',
        '音声処理が停止中のため、最後の PCM を確認できませんでした。',
      )
    }
    await new Promise<void>((resolve, reject) => {
      let settled = false
      let timeout: ReturnType<typeof globalThis.setTimeout> | undefined
      const finish = (): void => {
        if (settled) return
        settled = true
        if (timeout !== undefined) globalThis.clearTimeout(timeout)
        this.stopAck = null
        resolve()
      }
      this.stopAck = finish
      node.port.postMessage({ type: 'stop' })
      timeout = globalThis.setTimeout(() => {
        if (settled) return
        settled = true
        this.stopAck = null
        reject(
          new CaptureError(
            'stop',
            '録音処理の停止確認がタイムアウトしました。',
          ),
        )
      }, STOP_ACK_TIMEOUT_MS)
    })
  }

  private readonly setReanalysisCallbacks = (
    resolve: (frames: PitchFrame[]) => void,
    reject: (error: CaptureError) => void,
  ): void => {
    this.reanalysisResolve = resolve
    this.reanalysisReject = reject
  }

  private clearReanalysisCallbacks(): void {
    this.reanalysisResolve = null
    this.reanalysisReject = null
  }

  private failAndStop(error: CaptureError): void {
    if (this.state !== 'running' && this.state !== 'stopping') return
    this.terminalError ??= error
    const stopping = this.stop()
    this.reportFailure(error)
    void stopping.catch(() => undefined)
  }

  private reportFailure(error: CaptureError): void {
    if (this.failureReported) return
    this.failureReported = true
    callSafely(() => this.callbacks.onFailure?.(error))
  }

  private assertCurrent(generation: number): void {
    if (generation !== this.generation || this.state === 'cancelled') {
      throw new CaptureError('cancelled', '録音開始はキャンセルされました。')
    }
  }

  private stopTrackAndAudioGraph(): void {
    if (this.audioGraphStopped) return
    this.audioGraphStopped = true
    this.source?.disconnect()
    this.node?.disconnect()
    stopStream(this.stream)
  }

  private async releaseResources(): Promise<void> {
    this.track?.removeEventListener('ended', this.handleTrackInterruption)
    this.track?.removeEventListener('mute', this.handleTrackInterruption)
    if (this.context)
      this.context.removeEventListener(
        'statechange',
        this.handleContextStateChange,
      )
    this.stopTrackAndAudioGraph()
    this.node && (this.node.port.onmessage = null)
    if (this.node) this.node.onprocessorerror = null
    if (this.worker) {
      this.worker.onmessage = null
      this.worker.onerror = null
      this.worker.terminate()
    }
    const context = this.context
    this.stream = null
    this.track = null
    this.source = null
    this.node = null
    this.worker = null
    this.context = null
    this.chunks = []
    this.totalSamples = 0
    this.clearReanalysisCallbacks()
    if (context && context.state !== 'closed')
      await context.close().catch(() => undefined)
  }
}

/** Worker へ一回の offline 解析を依頼する。 */
function analyzeWithWorker(
  worker: Worker,
  samples: Float32Array,
  sampleRate: number,
  mode: AnalysisMode,
  installCallbacks?: (
    resolve: (frames: PitchFrame[]) => void,
    reject: (error: CaptureError) => void,
  ) => void,
  onProgress?: (progress: number) => void,
  options: ReanalysisOptions = {},
): Promise<PitchFrame[]> {
  return new Promise<PitchFrame[]>((resolve, reject) => {
    let settled = false
    const timeout = globalThis.setTimeout(() => {
      settleReject(
        new CaptureError('worker', '音程の再解析がタイムアウトしました。'),
      )
    }, ANALYSIS_TIMEOUT_MS)
    const settleResolve = (frames: PitchFrame[]): void => {
      if (settled) return
      settled = true
      globalThis.clearTimeout(timeout)
      options.signal?.removeEventListener('abort', abort)
      resolve(frames)
    }
    const settleReject = (error: CaptureError): void => {
      if (settled) return
      settled = true
      globalThis.clearTimeout(timeout)
      options.signal?.removeEventListener('abort', abort)
      reject(error)
    }
    const abort = (): void => settleReject(new CaptureError('cancelled', '音声の分析を中止しました。'))
    options.signal?.addEventListener('abort', abort, { once: true })
    if (options.signal?.aborted) { abort(); return }
    if (installCallbacks) {
      installCallbacks(settleResolve, settleReject)
    } else {
      worker.onmessage = (event: MessageEvent<WorkerOutput>): void => {
        if (event.data.type === 'done') settleResolve(event.data.frames)
        else if (event.data.type === 'progress' && !settled) {
          const progress = event.data.progress
          callSafely(() => onProgress?.(progress))
        } else if (event.data.type === 'error')
          settleReject(new CaptureError('worker', event.data.message))
      }
      worker.onerror = (event: ErrorEvent): void => {
        settleReject(
          new CaptureError(
            'worker',
            event.message || '音程解析 Worker でエラーが発生しました。',
          ),
        )
      }
    }
    const copy = samples.slice()
    try {
      worker.postMessage({ type: 'reanalyze', samples: copy, sampleRate, mode, calibrate: options.calibrate }, [copy.buffer])
    } catch (error) {
      settleReject(new CaptureError('worker', '解析を開始できませんでした。', { cause: error }))
    }
  })
}

/** 実ブラウザ用の Web Audio 依存を遅延して解決する。 */
function browserRuntime(): CaptureRuntime {
  const AudioContextConstructor = globalThis.AudioContext
  return {
    supportsAudioWorklet:
      typeof AudioContextConstructor !== 'undefined' &&
      typeof globalThis.AudioWorkletNode !== 'undefined' &&
      typeof navigator !== 'undefined' &&
      Boolean(navigator.mediaDevices?.getUserMedia),
    getSupportedConstraints: () =>
      navigator.mediaDevices.getSupportedConstraints?.() ?? {},
    getUserMedia: (constraints) =>
      navigator.mediaDevices.getUserMedia(constraints),
    createAudioContext: () => new AudioContextConstructor(),
    createAudioWorkletNode: (context, options) =>
      new AudioWorkletNode(context, 'pcm-capture', options),
    createWorker: createBrowserWorker,
    workletUrl: captureWorkletUrl,
  }
}

/** Vite が bundle 可能な module Worker を作る。 */
function createBrowserWorker(): Worker {
  return new Worker(new URL('./analysis-worker.ts', import.meta.url), {
    type: 'module',
  })
}

/** 複数 PCM chunk を一つの連続したサンプル列へ連結する。 */
function joinChunks(
  chunks: readonly Float32Array[],
  totalSamples: number,
): Float32Array {
  const joined = new Float32Array(totalSamples)
  let offset = 0
  for (const chunk of chunks) {
    joined.set(chunk, offset)
    offset += chunk.length
  }
  return joined
}

/** stream に属する全 track を停止する。 */
function stopStream(stream: MediaStream | null): void {
  for (const track of stream?.getTracks() ?? []) track.stop()
}

/** getUserMedia の制約不一致だけをフォールバック対象にする。 */
function isOverconstrained(error: unknown): boolean {
  return error instanceof Error && error.name === 'OverconstrainedError'
}

/** start 境界の DOMException を UI 向け CaptureError へ変換する。 */
function normalizeStartError(error: unknown): CaptureError {
  if (error instanceof CaptureError) return error
  if (
    error instanceof Error &&
    (error.name === 'NotAllowedError' || error.name === 'SecurityError')
  ) {
    return new CaptureError(
      'permission',
      'マイクの使用が許可されませんでした。',
      { cause: error },
    )
  }
  return new CaptureError('start', '録音を開始できませんでした。', {
    cause: error,
  })
}

/** stop 境界の例外を CaptureError へ正規化する。 */
function normalizeStopError(error: unknown): CaptureError {
  if (error instanceof CaptureError) return error
  return new CaptureError('stop', '録音の停止処理に失敗しました。', {
    cause: error,
  })
}

/** UI callback の例外を音声リソース管理へ波及させない。 */
function callSafely(callback: () => void): void {
  try {
    callback()
  } catch {
    // UI callback の例外は呼び出し側の責務とし、録音境界は継続する。
  }
}
