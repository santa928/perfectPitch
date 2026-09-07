import { test, expect } from '@playwright/test'

test('周期ごとの音量が揺れる歌声をWorklet/Workerで解析し、停止後に前後関係を見直す', async ({ page }) => {
  await page.goto('./')
  const result = await page.evaluate(async () => {
    // @ts-expect-error Vite serves the shared browser module.
    const { CaptureSession } = await import('/perfectPitch/src/audio/capture.ts')
    // @ts-expect-error Vite serves the deterministic public fixture.
    const { variableGainVoice } = await import('/perfectPitch/tests/fixtures/period-voice.ts')
    // @ts-expect-error Vite serves the shared note conversion.
    const { buildNotes } = await import('/perfectPitch/src/analysis/notes.ts')
    // @ts-expect-error Vite serves the same detector with an optional context.
    const { detectYin } = await import('/perfectPitch/src/analysis/detectors.ts')
    // @ts-expect-error Vite serves the offline review implementation.
    const { analyzeOffline } = await import('/perfectPitch/src/analysis/offline.ts')
    // @ts-expect-error Vite serves the unchanged causal analyzer.
    const { analyze } = await import('/perfectPitch/src/analysis/pipeline.ts')
    const context = new AudioContext({ sampleRate: 48000 })
    const pcm = variableGainVoice(context.sampleRate)
    const buffer = context.createBuffer(1, pcm.length, context.sampleRate)
    buffer.copyToChannel(pcm, 0)
    const destination = context.createMediaStreamDestination()
    const source = context.createBufferSource()
    source.buffer = buffer
    source.connect(destination)
    const live: { t: number; frequency: number | null }[] = []
    const session = new CaptureSession('song', { onFrames: (frames: typeof live) => live.push(...frames) }, {
      supportsAudioWorklet: true,
      getSupportedConstraints: () => ({}),
      getUserMedia: async () => destination.stream,
      createAudioContext: () => context,
      createAudioWorkletNode: (ctx: AudioContext, options: AudioWorkletNodeOptions) => new AudioWorkletNode(ctx, 'pcm-capture', options),
      createWorker: () => new Worker('/perfectPitch/src/audio/analysis-worker.ts', { type: 'module' }),
      workletUrl: '/perfectPitch/src/audio/capture-worklet.js',
    })
    await session.start()
    source.start()
    await new Promise(resolve => setTimeout(resolve, 2200))
    const recording = await session.stop()
    const active = recording.frames.filter((f: { t: number }) => f.t > 0.5 && f.t < 1.4)
    const size = Math.round(recording.sampleRate * 0.08)
    const strict = active.map((f: { t: number }) => {
      const start = Math.round(f.t * recording.sampleRate - size / 2)
      return detectYin(recording.samples.subarray(start, start + size), recording.sampleRate)
    })
    const errors = (frames: { frequency: number | null }[]) => frames.filter(f => !f.frequency || Math.abs(1200 * Math.log2(f.frequency / 150)) > 50).length
    return {
      live,
      final: recording.frames,
      expectedLive: analyze(recording.samples, recording.sampleRate, 'song'),
      expectedFinal: analyzeOffline(recording.samples, recording.sampleRate, 'song'),
      notes: buildNotes(recording.frames, 'song', 'continuous', recording.samples.length / recording.sampleRate),
      errors: { strict: errors(strict), bounded: errors(active) },
    }
  })
  expect(result.live.length).toBeGreaterThan(100)
  expect(result.live).toEqual(result.expectedLive.slice(0, result.live.length))
  expect(result.final).toEqual(result.expectedFinal)
  expect(result.live.map(f => f.t)).toEqual(result.final.slice(0, result.live.length).map(f => f.t))
  expect(result.notes.length).toBeGreaterThan(0)
  expect(result.errors.bounded).toBeLessThan(result.errors.strict)
})
