const MAX_FILE_BYTES = 20 * 1024 * 1024
const TARGET_SAMPLE_RATE = 48000

export type AudioImportErrorCode =
  | 'file-too-large'
  | 'too-long'
  | 'invalid-metadata'
  | 'decode'
  | 'invalid-audio'
  | 'aborted'
  | 'unsupported'

export type AudioImportStage =
  | 'metadata'
  | 'reading'
  | 'decoding'
  | 'normalizing'
  | 'complete'

export type AudioImportProgress = {
  stage: AudioImportStage
  progress: number
}

export type ImportedAudio = {
  samples: Float32Array
  sampleRate: number
  duration: number
  name: string
  type: string
}

/** decodeAudioData の結果から importer が利用する最小境界。 */
export type DecodedAudioData = {
  sampleRate: number
  length: number
  duration: number
  numberOfChannels: number
  getChannelData(channel: number): Float32Array
}

/** metadata 読み込みに使う audio 要素の寿命を明示する境界。 */
export type AudioMetadataProbe = {
  load(url: string, signal: AbortSignal): Promise<number>
  dispose(): void
}

/** ブラウザ API を単体テストから差し替えるための実行環境。 */
export type AudioImportRuntime = {
  createObjectUrl(file: Blob): string
  revokeObjectUrl(url: string): void
  createMetadataProbe(): AudioMetadataProbe
  readFile(file: Blob, signal: AbortSignal): Promise<ArrayBuffer>
  decodeAudioData(data: ArrayBuffer, sampleRate: number): Promise<DecodedAudioData>
}

export type AudioImportOptions = {
  signal?: AbortSignal
  onProgress?(event: AudioImportProgress): void
  runtime?: AudioImportRuntime
}

/** UI が失敗理由を安定して表示するための音声インポートエラー。 */
export class AudioImportError extends Error {
  readonly code: AudioImportErrorCode

  constructor(code: AudioImportErrorCode, message: string, options?: ErrorOptions) {
    super(message, options)
    this.name = 'AudioImportError'
    this.code = code
  }
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError'
}

function abortError(cause?: unknown): AudioImportError {
  return new AudioImportError('aborted', '音声の読み込みを中止しました。', {
    cause,
  })
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) throw abortError(signal.reason)
}

function invalidAudio(message: string): AudioImportError {
  return new AudioImportError('invalid-audio', message)
}

function validateDecodedAudio(decoded: DecodedAudioData): void {
  if (!Number.isFinite(decoded.duration) || decoded.duration <= 0) {
    throw invalidAudio('decode 後の音声の長さが不正です。')
  }
  if (decoded.duration > 60) {
    throw new AudioImportError(
      'too-long',
      'decode 後の音声が 60秒を超えています。',
    )
  }
  if (decoded.sampleRate !== TARGET_SAMPLE_RATE) {
    throw invalidAudio('音声を 48 kHz に変換できませんでした。')
  }
  if (!Number.isInteger(decoded.length) || decoded.length <= 0) {
    throw invalidAudio('decode 後の PCM サンプル数が不正です。')
  }
  if (decoded.length > TARGET_SAMPLE_RATE * 60) {
    throw new AudioImportError(
      'too-long',
      'decode 後の音声が 60秒を超えています。',
    )
  }
  if (
    !Number.isInteger(decoded.numberOfChannels) ||
    decoded.numberOfChannels <= 0
  ) {
    throw invalidAudio('decode 後のチャンネル数が不正です。')
  }
}

function createMetadataProbe(): AudioMetadataProbe {
  const element = document.createElement('audio')
  element.preload = 'metadata'

  return {
    load(url, signal) {
      return new Promise<number>((resolve, reject) => {
        if (signal.aborted) {
          reject(new DOMException('aborted', 'AbortError'))
          return
        }

        const cleanup = (): void => {
          element.removeEventListener('loadedmetadata', handleMetadata)
          element.removeEventListener('error', handleError)
          signal.removeEventListener('abort', handleAbort)
        }
        const handleMetadata = (): void => {
          cleanup()
          resolve(element.duration)
        }
        const handleError = (): void => {
          cleanup()
          reject(new Error('audio metadata could not be loaded'))
        }
        const handleAbort = (): void => {
          cleanup()
          reject(new DOMException('aborted', 'AbortError'))
        }

        element.addEventListener('loadedmetadata', handleMetadata, {
          once: true,
        })
        element.addEventListener('error', handleError, { once: true })
        signal.addEventListener('abort', handleAbort, { once: true })
        try {
          element.src = url
          element.load()
        } catch (error) {
          cleanup()
          reject(error)
        }
      })
    },
    dispose() {
      element.pause()
      element.removeAttribute('src')
      element.load()
      element.remove()
    },
  }
}

function readFile(file: Blob, signal: AbortSignal): Promise<ArrayBuffer> {
  return new Promise<ArrayBuffer>((resolve, reject) => {
    if (signal.aborted) {
      reject(new DOMException('aborted', 'AbortError'))
      return
    }

    const reader = new FileReader()
    const cleanup = (): void => {
      reader.removeEventListener('load', handleLoad)
      reader.removeEventListener('error', handleError)
      reader.removeEventListener('abort', handleReaderAbort)
      signal.removeEventListener('abort', handleSignalAbort)
    }
    const handleLoad = (): void => {
      cleanup()
      if (reader.result instanceof ArrayBuffer) resolve(reader.result)
      else reject(new Error('file reader returned no ArrayBuffer'))
    }
    const handleError = (): void => {
      cleanup()
      reject(reader.error ?? new Error('audio file could not be read'))
    }
    const handleReaderAbort = (): void => {
      cleanup()
      reject(new DOMException('aborted', 'AbortError'))
    }
    const handleSignalAbort = (): void => reader.abort()

    reader.addEventListener('load', handleLoad, { once: true })
    reader.addEventListener('error', handleError, { once: true })
    reader.addEventListener('abort', handleReaderAbort, { once: true })
    signal.addEventListener('abort', handleSignalAbort, { once: true })
    try {
      reader.readAsArrayBuffer(file)
    } catch (error) {
      cleanup()
      reject(error)
    }
  })
}

function browserRuntime(): AudioImportRuntime {
  if (
    typeof document === 'undefined' ||
    typeof FileReader === 'undefined' ||
    typeof OfflineAudioContext === 'undefined' ||
    typeof URL === 'undefined' ||
    typeof URL.createObjectURL !== 'function'
  ) {
    throw new AudioImportError(
      'unsupported',
      'このブラウザは音声ファイルの読み込みに対応していません。',
    )
  }

  return {
    createObjectUrl: (file) => URL.createObjectURL(file),
    revokeObjectUrl: (url) => URL.revokeObjectURL(url),
    createMetadataProbe,
    readFile,
    async decodeAudioData(data, sampleRate) {
      const context = new OfflineAudioContext(1, 1, sampleRate)
      return context.decodeAudioData(data.slice(0))
    },
  }
}

/** ローカル音声をブラウザ内で検証し、48 kHz mono PCM に変換する。 */
export async function importAudio(
  file: File,
  options: AudioImportOptions = {},
): Promise<ImportedAudio> {
  const signal = options.signal ?? new AbortController().signal
  throwIfAborted(signal)
  if (file.size > MAX_FILE_BYTES) {
    throw new AudioImportError(
      'file-too-large',
      '音声ファイルは 20 MiB 以下を選んでください。',
    )
  }

  const runtime = options.runtime ?? browserRuntime()

  options.onProgress?.({ stage: 'metadata', progress: 0 })
  const url = runtime.createObjectUrl(file)
  let probe: AudioMetadataProbe | null = null
  try {
    probe = runtime.createMetadataProbe()
    const duration = await probe.load(
      url,
      signal,
    )
    if (!Number.isFinite(duration) || duration <= 0) {
      throw new AudioImportError(
        'invalid-metadata',
        '音声の長さを確認できませんでした。',
      )
    }
    if (duration > 60) {
      throw new AudioImportError(
        'too-long',
        '音声ファイルは 60秒以下を選んでください。',
      )
    }
  } catch (error) {
    if (error instanceof AudioImportError) throw error
    if (signal.aborted || isAbortError(error)) throw abortError(error)
    throw new AudioImportError(
      'invalid-metadata',
      '音声の情報を読み取れませんでした。WAV形式か、別のブラウザで試してください。',
      { cause: error },
    )
  } finally {
    try {
      probe?.dispose()
    } finally {
      runtime.revokeObjectUrl(url)
    }
  }

  options.onProgress?.({ stage: 'reading', progress: 0.15 })
  let data: ArrayBuffer
  try {
    data = await runtime.readFile(file, signal)
  } catch (error) {
    if (signal.aborted || isAbortError(error)) throw abortError(error)
    throw invalidAudio('音声ファイルを読み込めませんでした。')
  }
  throwIfAborted(signal)
  options.onProgress?.({ stage: 'decoding', progress: 0.35 })
  let decoded: DecodedAudioData
  try {
    decoded = await runtime.decodeAudioData(data, TARGET_SAMPLE_RATE)
  } catch (error) {
    if (signal.aborted || isAbortError(error)) throw abortError(error)
    throw new AudioImportError('decode', '音声形式を読み取れませんでした。WAV形式か、別のブラウザで試してください。', {
      cause: error,
    })
  }
  throwIfAborted(signal)
  validateDecodedAudio(decoded)
  options.onProgress?.({ stage: 'normalizing', progress: 0.8 })
  const samples = new Float32Array(decoded.length)
  for (let channel = 0; channel < decoded.numberOfChannels; channel += 1) {
    const source = decoded.getChannelData(channel)
    if (source.length !== decoded.length) {
      throw invalidAudio('decode 後の PCM チャンネル長が一致しません。')
    }
    for (let index = 0; index < decoded.length; index += 1) {
      if (!Number.isFinite(source[index])) {
        throw invalidAudio('decode 後の PCM に不正な値があります。')
      }
      samples[index] += source[index] / decoded.numberOfChannels
    }
  }
  options.onProgress?.({ stage: 'complete', progress: 1 })

  return {
    samples,
    sampleRate: decoded.sampleRate,
    duration: decoded.duration,
    name: file.name,
    type: file.type,
  }
}
