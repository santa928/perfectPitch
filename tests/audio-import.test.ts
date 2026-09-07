import assert from 'node:assert/strict'
import test from 'node:test'
import {
  AudioImportError,
  importAudio,
  type AudioImportProgress,
  type AudioImportRuntime,
  type DecodedAudioData,
} from '../src/audio/import.ts'

function unusedRuntime(): AudioImportRuntime {
  return {
    createObjectUrl: () => {
      throw new Error('metadata must not be read')
    },
    revokeObjectUrl: () => {},
    createMetadataProbe: () => {
      throw new Error('metadata must not be read')
    },
    readFile: async () => {
      throw new Error('file must not be read')
    },
    decodeAudioData: async () => {
      throw new Error('audio must not be decoded')
    },
  }
}

type RuntimeFixture = {
  runtime: AudioImportRuntime
  calls: string[]
  disposed: () => number
  revoked: () => string[]
}

function runtimeFixture(options: {
  metadataDuration?: number
  metadataError?: unknown
  metadataWaitForAbort?: boolean
  decoded?: DecodedAudioData
} = {}): RuntimeFixture {
  const calls: string[] = []
  let disposeCount = 0
  const revokedUrls: string[] = []
  const decoded = options.decoded ?? {
    sampleRate: 48000,
    length: 3,
    duration: 3 / 48000,
    numberOfChannels: 2,
    getChannelData: (channel) =>
      channel === 0
        ? new Float32Array([1, 0.5, -1])
        : new Float32Array([0, -0.5, 1]),
  }

  return {
    calls,
    disposed: () => disposeCount,
    revoked: () => revokedUrls,
    runtime: {
      createObjectUrl: () => {
        calls.push('create-url')
        return 'blob:test-audio'
      },
      revokeObjectUrl: (url) => {
        calls.push('revoke-url')
        revokedUrls.push(url)
      },
      createMetadataProbe: () => {
        calls.push('create-probe')
        return {
          load: async (_url, signal) => {
            calls.push('load-metadata')
            if (options.metadataError) throw options.metadataError
            if (options.metadataWaitForAbort) {
              return new Promise<number>((_resolve, reject) => {
                signal.addEventListener(
                  'abort',
                  () => reject(new DOMException('aborted', 'AbortError')),
                  { once: true },
                )
              })
            }
            return options.metadataDuration ?? 0.5
          },
          dispose: () => {
            calls.push('dispose-probe')
            disposeCount += 1
          },
        }
      },
      readFile: async () => {
        calls.push('read-file')
        return new Uint8Array([1, 2, 3]).buffer
      },
      decodeAudioData: async () => {
        calls.push('decode')
        return decoded
      },
    },
  }
}

test('20 MiB を超える音声は metadata 読み込み前に拒否する', async () => {
  const file = new File([new Uint8Array(20 * 1024 * 1024 + 1)], 'large.m4a')

  await assert.rejects(
    importAudio(file, { runtime: unusedRuntime() }),
    (error: unknown) =>
      error instanceof AudioImportError && error.code === 'file-too-large',
  )
})

test('metadata を先に確認してから未知の MIME の音声を 48 kHz mono PCM にする', async () => {
  const fixture = runtimeFixture()
  const progress: AudioImportProgress[] = []
  const file = new File([new Uint8Array([1, 2, 3])], 'voice.unknown', {
    type: 'application/octet-stream',
  })

  const result = await importAudio(file, {
    runtime: fixture.runtime,
    onProgress: (event) => progress.push(event),
  })

  assert.deepEqual(Array.from(result.samples), [0.5, 0, 0])
  assert.equal(result.sampleRate, 48000)
  assert.equal(result.duration, 3 / 48000)
  assert.equal(result.name, 'voice.unknown')
  assert.equal(result.type, 'application/octet-stream')
  assert.deepEqual(fixture.calls, [
    'create-url',
    'create-probe',
    'load-metadata',
    'dispose-probe',
    'revoke-url',
    'read-file',
    'decode',
  ])
  assert.deepEqual(
    progress.map(({ stage }) => stage),
    ['metadata', 'reading', 'decoding', 'normalizing', 'complete'],
  )
  assert.deepEqual(
    progress.map(({ progress: value }) => value),
    [0, 0.15, 0.35, 0.8, 1],
  )
})

test('60 秒を超える圧縮音声は full decode 前に拒否して metadata 資源を解放する', async () => {
  const fixture = runtimeFixture({ metadataDuration: 60.001 })
  const file = new File([new Uint8Array([1])], 'long.m4a')

  await assert.rejects(
    importAudio(file, { runtime: fixture.runtime }),
    (error: unknown) =>
      error instanceof AudioImportError && error.code === 'too-long',
  )
  assert.deepEqual(fixture.calls, [
    'create-url',
    'create-probe',
    'load-metadata',
    'dispose-probe',
    'revoke-url',
  ])
  assert.equal(fixture.disposed(), 1)
  assert.deepEqual(fixture.revoked(), ['blob:test-audio'])
})

test('metadata 読み込み失敗でも audio 要素と blob URL を解放する', async () => {
  const fixture = runtimeFixture({ metadataError: new Error('metadata failed') })
  const file = new File([new Uint8Array([1])], 'broken.m4a')

  await assert.rejects(
    importAudio(file, { runtime: fixture.runtime }),
    (error: unknown) =>
      error instanceof AudioImportError && error.code === 'invalid-metadata',
  )
  assert.equal(fixture.disposed(), 1)
  assert.deepEqual(fixture.revoked(), ['blob:test-audio'])
  assert.equal(fixture.calls.includes('read-file'), false)
})

test('metadata 要素を作れない場合も作成済み blob URL を解放する', async () => {
  const fixture = runtimeFixture()
  fixture.runtime.createMetadataProbe = () => {
    throw new Error('audio element unavailable')
  }

  await assert.rejects(
    importAudio(new File([new Uint8Array([1])], 'voice.m4a'), {
      runtime: fixture.runtime,
    }),
    (error: unknown) =>
      error instanceof AudioImportError && error.code === 'invalid-metadata',
  )
  assert.deepEqual(fixture.revoked(), ['blob:test-audio'])
  assert.equal(fixture.calls.includes('read-file'), false)
})

test('metadata 読み込み中の中止を通知して audio 要素と blob URL を解放する', async () => {
  const fixture = runtimeFixture({ metadataWaitForAbort: true })
  const controller = new AbortController()
  const file = new File([new Uint8Array([1])], 'voice.m4a')

  const importing = importAudio(file, {
    runtime: fixture.runtime,
    signal: controller.signal,
  })
  controller.abort()

  await assert.rejects(
    importing,
    (error: unknown) =>
      error instanceof AudioImportError && error.code === 'aborted',
  )
  assert.equal(fixture.disposed(), 1)
  assert.deepEqual(fixture.revoked(), ['blob:test-audio'])
  assert.equal(fixture.calls.includes('read-file'), false)
})

test('中止後に decode が完了しても古い PCM を返さない', async () => {
  const fixture = runtimeFixture()
  const controller = new AbortController()
  const progress: AudioImportProgress[] = []
  let resolveDecode!: (audio: DecodedAudioData) => void
  let markDecodeStarted!: () => void
  const decodeStarted = new Promise<void>((resolve) => {
    markDecodeStarted = resolve
  })
  const decoded = {
    sampleRate: 48000,
    length: 1,
    duration: 1 / 48000,
    numberOfChannels: 1,
    getChannelData: () => new Float32Array([0.25]),
  }
  fixture.runtime.decodeAudioData = async () => {
    markDecodeStarted()
    return new Promise<DecodedAudioData>((resolve) => {
      resolveDecode = resolve
    })
  }

  const importing = importAudio(
    new File([new Uint8Array([1])], 'voice.m4a'),
    {
      runtime: fixture.runtime,
      signal: controller.signal,
      onProgress: (event) => progress.push(event),
    },
  )
  await decodeStarted
  controller.abort()
  resolveDecode(decoded)

  await assert.rejects(
    importing,
    (error: unknown) =>
      error instanceof AudioImportError && error.code === 'aborted',
  )
  assert.equal(progress.at(-1)?.stage, 'decoding')
})

test('decode 後にも長さ・sample rate・finite PCM を検証する', async (t) => {
  const cases: Array<{
    name: string
    decoded: DecodedAudioData
    code: 'too-long' | 'invalid-audio'
  }> = [
    {
      name: 'metadata と異なり decode 後は 60 秒超過',
      decoded: {
        sampleRate: 48000,
        length: 60 * 48000 + 1,
        duration: 60 + 1 / 48000,
        numberOfChannels: 1,
        getChannelData: () => new Float32Array(60 * 48000 + 1),
      },
      code: 'too-long',
    },
    {
      name: '48 kHz 以外の decode 結果',
      decoded: {
        sampleRate: 44100,
        length: 2,
        duration: 2 / 44100,
        numberOfChannels: 1,
        getChannelData: () => new Float32Array([0, 0]),
      },
      code: 'invalid-audio',
    },
    {
      name: '非 finite PCM',
      decoded: {
        sampleRate: 48000,
        length: 2,
        duration: 2 / 48000,
        numberOfChannels: 1,
        getChannelData: () => new Float32Array([0, Number.NaN]),
      },
      code: 'invalid-audio',
    },
  ]

  for (const item of cases) {
    await t.test(item.name, async () => {
      const fixture = runtimeFixture({ decoded: item.decoded })

      await assert.rejects(
        importAudio(new File([new Uint8Array([1])], 'voice.m4a'), {
          runtime: fixture.runtime,
        }),
        (error: unknown) =>
          error instanceof AudioImportError && error.code === item.code,
      )
    })
  }
})
