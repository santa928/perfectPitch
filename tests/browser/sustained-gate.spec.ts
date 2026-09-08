import { test, expect } from '@playwright/test'

for (const ongoingNoise of [false, true]) {
test(`合成長音（定常雑音${ongoingNoise ? 'あり' : 'なし'}）を実Worklet/Workerで録音し、同じPCMのファイル入力と末尾を比較する`, async ({ page }) => {
  test.setTimeout(90000)
  await page.addInitScript(() => {
    const received: { type: string; frames?: { t: number; frequency: number | null }[] }[] = []
    Object.assign(window, { sustainedWorkerOutput: received })
    const NativeWorker = window.Worker
    window.Worker = class extends NativeWorker {
      constructor(url: string | URL, options?: WorkerOptions) {
        super(url, options)
        // 通信は観測のみ。実Workerの出力/実行時刻/転送PCMを改変しない。
        this.addEventListener('message', event => {
          if (event.data.type === 'done') received.push(event.data)
        })
      }
    }
  })
  await page.goto('./')
  const result = await page.evaluate(async (ongoingNoise) => {
    // @ts-expect-error Viteの実モジュールを使い、Worker出力を差し替えない。
    const { CaptureSession } = await import('/perfectPitch/src/audio/capture.ts')
    // @ts-expect-error 固定PCMのみがテスト用。
    const { sustainedInput } = await import('/perfectPitch/tests/fixtures/sustained-voice.ts')
    // @ts-expect-error レビューの定常雑音付きPCM。
    const { sustainedNoise } = await import('/perfectPitch/tests/fixtures/sustained-noise.ts')
    // @ts-expect-error 本番の音符化。
    const { buildNotes } = await import('/perfectPitch/src/analysis/notes.ts')
    const context = new AudioContext({ sampleRate: 48000 })
    const pcm = ongoingNoise ? sustainedNoise(context.sampleRate) : sustainedInput(context.sampleRate)
    const buffer = context.createBuffer(1, pcm.length, context.sampleRate)
    buffer.copyToChannel(pcm, 0)
    const destination = context.createMediaStreamDestination(), source = context.createBufferSource()
    source.buffer = buffer; source.connect(destination)
    type Frame = { t: number; frequency: number | null }
    const live: Frame[] = [], progress: number[] = [], chunks: Float32Array[] = []
    let acknowledgedSamples: number | undefined
    const session = new CaptureSession('song', { onFrames: (frames: Frame[]) => live.push(...frames),
      onAnalysisProgress: (value: number) => progress.push(value) }, {
      supportsAudioWorklet: true, getSupportedConstraints: () => ({}),
      getUserMedia: async () => destination.stream, createAudioContext: () => context,
      createAudioWorkletNode: (ctx: AudioContext, options: AudioWorkletNodeOptions) => {
        const node = new AudioWorkletNode(ctx, 'pcm-capture', options)
        node.port.addEventListener('message', event => {
          if (event.data.type === 'samples') chunks.push(event.data.samples.slice())
          if (event.data.type === 'stopped') acknowledgedSamples = event.data.totalSamples
        })
        return node
      },
      createWorker: () => new Worker('/perfectPitch/src/audio/analysis-worker.ts', { type: 'module' }),
      workletUrl: '/perfectPitch/src/audio/capture-worklet.js',
    })
    await session.start()
    source.start()
    await new Promise(resolve => setTimeout(resolve, 6400))
    const start = performance.now(), recording = await session.stop()
    const elapsed = performance.now() - start
    const frames: Frame[] = recording.frames
    const correct = (values: Frame[]) => {
      const tail = values.filter(f => f.t >= 1.2 && f.t <= 5.8)
      return tail.filter(f => f.frequency && Math.abs(1200 * Math.log2(f.frequency / 220)) < 50).length / tail.length
    }
    // 取得PCMそのものをローカルWAVにし、通常のファイル入力UIへ渡す。
    const bytes = new Uint8Array(44 + recording.samples.length * 4), view = new DataView(bytes.buffer)
    const text = (offset: number, value: string) => [...value].forEach((c, i) => view.setUint8(offset + i, c.charCodeAt(0)))
    text(0, 'RIFF'); view.setUint32(4, bytes.length - 8, true); text(8, 'WAVEfmt ')
    view.setUint32(16, 16, true); view.setUint16(20, 3, true); view.setUint16(22, 1, true)
    view.setUint32(24, recording.sampleRate, true); view.setUint32(28, recording.sampleRate * 4, true)
    view.setUint16(32, 4, true); view.setUint16(34, 32, true); text(36, 'data'); view.setUint32(40, bytes.length - 44, true)
    recording.samples.forEach((value: number, i: number) => view.setFloat32(44 + i * 4, value, true))
    const transfer = new DataTransfer()
    transfer.items.add(new File([bytes], 'synthetic-sustained.wav', { type: 'audio/wav' }))
    const input = document.querySelector('#audioFile') as HTMLInputElement
    input.files = transfer.files; input.dispatchEvent(new Event('change', { bubbles: true }))
    let offset = 0, pcmMatches = true
    for (const chunk of chunks) for (const value of chunk) {
      if (recording.samples[offset++] !== value) pcmMatches = false
    }
    return { liveCoverage: correct(live), finalCoverage: correct(frames), elapsed,
      receivedSamples: offset, acknowledgedSamples, pcmMatches,
      coreFrequencies: frames.filter(f => f.t >= 1.2 && f.t <= 5.8).map(f => f.frequency),
      samples: recording.samples.length, sampleRate: recording.sampleRate, progress,
      lastFrame: frames.at(-1)?.t, lastLive: live.at(-1)?.t,
      lastVoiced: frames.findLast(f => f.frequency)?.t,
      noteEnd: buildNotes(frames, 'song', 'continuous', recording.samples.length / recording.sampleRate).at(-1)?.end,
      error: recording.analysisError }
  }, ongoingNoise)
  expect(result.error).toBeUndefined()
  expect(result.pcmMatches).toBe(true)
  expect(result.receivedSamples).toBe(result.samples)
  expect(result.acknowledgedSamples).toBe(result.samples)
  expect(result.liveCoverage).toBeGreaterThanOrEqual(.99)
  expect(result.finalCoverage).toBeGreaterThanOrEqual(.99)
  expect(result.samples / result.sampleRate).toBeGreaterThanOrEqual(6)
  expect(result.samples / result.sampleRate - result.lastFrame!).toBeLessThan(.06)
  expect(result.lastVoiced).toBeGreaterThan(5.9)
  expect(result.noteEnd).toBeGreaterThan(5.9)
  expect(result.progress.at(-1)).toBe(1)
  await expect(page.locator('#status')).toContainText('読み込みました', { timeout: 60000 })
  const imported = await page.evaluate(async () => {
    // @ts-expect-error 実ファイル入力Workerの結果を本番の音符化へ渡す。
    const { buildNotes } = await import('/perfectPitch/src/analysis/notes.ts')
    const outputs = (window as unknown as { sustainedWorkerOutput: { frames: { t: number; frequency: number | null }[] }[] }).sustainedWorkerOutput
    const frames = outputs.at(-1)!.frames
    const tail = frames.filter(f => f.t >= 1.2 && f.t <= 5.8)
    return { runs: outputs.length, coverage: tail.filter(f => f.frequency && Math.abs(1200 * Math.log2(f.frequency / 220)) < 50).length / tail.length,
      coreFrequencies: tail.map(f => f.frequency),
      lastFrame: frames.at(-1)?.t, lastVoiced: frames.findLast(f => f.frequency)?.t,
      noteEnd: buildNotes(frames, 'song', 'continuous', 6.5).at(-1)?.end }
  })
  expect(imported.runs).toBe(2)
  expect(imported.coverage).toBeGreaterThanOrEqual(.99)
  expect(imported.lastFrame).toBe(result.lastFrame)
  expect(imported.coreFrequencies).toEqual(result.coreFrequencies)
  expect(imported.lastVoiced).toBeGreaterThan(5.9)
  expect(imported.noteEnd).toBeGreaterThan(5.9)
  // ファイルは校正なし。窓末端の低周期性部分は両ゲートで異なるため半窓+1hop内に制限。
  expect(Math.abs(imported.lastVoiced! - result.lastVoiced!)).toBeLessThanOrEqual(.05)
  expect(Math.abs(imported.noteEnd! - result.noteEnd!)).toBeLessThanOrEqual(.05)
  await page.locator('#scoreDetails > summary').click()
  await expect(page.locator('#scoreMeasures')).toContainText('ラ3')
  console.log(JSON.stringify({ recording: { ...result, coreFrequencies: undefined }, imported: { ...imported, coreFrequencies: undefined } }))
})
}

test('30・60秒PCMは本番Workerの再解析timeout以内に末尾まで進む', async ({ page }) => {
  test.setTimeout(180000)
  await page.goto('./')
  const results = await page.evaluate(async () => {
    // @ts-expect-error 本番のtimeout付きWorker経路。
    const { reanalyze } = await import('/perfectPitch/src/audio/capture.ts')
    // @ts-expect-error 合成PCM。
    const { sustainedNoise } = await import('/perfectPitch/tests/fixtures/sustained-noise.ts')
    const rows = []
    for (const seconds of [30, 60]) {
      const pcm = sustainedNoise(48000, .8, false, true, seconds), progress: number[] = [], start = performance.now()
      const frames = await reanalyze(pcm, 48000, 'song', (p: number) => progress.push(p))
      rows.push({ seconds, elapsedMs: performance.now() - start, samples: pcm.length,
        lastVoiced: frames.findLast((f: { frequency: number | null }) => f.frequency)?.t,
        frames: frames.length, progress: progress.at(-1) })
    }
    return rows
  })
  for (const row of results) {
    expect(row.samples).toBe(row.seconds * 48000)
    expect(row.lastVoiced).toBeCloseTo(row.seconds - .04, 5)
    expect(row.frames).toBe(row.seconds * 100 - 7)
    expect(row.progress).toBe(1)
    expect(row.elapsedMs).toBeLessThan(60000)
  }
  console.log(JSON.stringify(results))
})
