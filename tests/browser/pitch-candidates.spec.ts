import { test as base, expect } from '@playwright/test'
import { resolve } from 'node:path'

// fake deviceの再生時計を各録音でリセットする。BrowserContextだけでは共有プロセスに残る。
const test = base.extend({
  page: async ({ playwright, launchOptions, baseURL }, use) => {
    const browser = await playwright.chromium.launch(launchOptions)
    try {
      const context = await browser.newContext({ baseURL })
      await use(await context.newPage())
    } finally {
      await browser.close()
    }
  },
})

test.use({ launchOptions: { args: [
  '--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream',
  `--use-file-for-fake-audio-capture=${resolve('output/test-dominant-second.wav')}`,
] } })

for (const mode of ['song', 'speech']) {
  test(`${mode}: 強い倍音を持つ声の基音と、本物の音程跳躍をブラウザ録音で残す`, async ({ page }) => {
    await page.goto('./')
    await page.locator(`input[name="voiceMode"][value="${mode}"]`).check()
    await page.locator('#record').click()
    await expect(page.locator('#phase')).toHaveText('録音中・暫定')
    await page.waitForTimeout(2900)
    await page.locator('#record').click()
    await expect(page.locator('#phase')).toHaveText('録音済み')
    await expect(page.locator('#micSettings')).toContainText('ノイズ抑制 無効')
    // 音声時計の1秒と2.5秒で実際の解析値をUIから観測する。
    for (const [time, label] of [[1, 'C3'], [2.5, 'C4']] as const) {
      await page.locator('#seek').evaluate((element, time) => {
        const seek = element as HTMLInputElement
        seek.value = String(time)
        seek.dispatchEvent(new Event('input', { bubbles: true }))
      }, time)
      await expect(page.locator('#pitchSummary')).toContainText(label)
    }
    await page.locator('input[name="source"][value="piano"]').check()
    await expect(page.locator('#play')).toBeEnabled()
    await page.locator('#scoreDetails > summary').click()
    await expect(page.locator('#scoreMeasures svg').first()).toBeVisible()
    await expect(page.locator('#scoreMeasures')).toContainText('ド3')
    await expect(page.locator('#scoreMeasures')).toContainText('ド4')
  })

  test(`${mode}: 合成ストリームのWorklet/Worker経路で境界の余計な音を作らない`, async ({ page }) => {
    await page.goto('./')
    const result = await page.evaluate(async (mode) => {
      // @ts-expect-error Vite serves the browser module.
      const { CaptureSession } = await import('/perfectPitch/src/audio/capture.ts')
      // @ts-expect-error Vite serves the browser module.
      const { buildNotes } = await import('/perfectPitch/src/analysis/notes.ts')
      // fake hardwareの供給欠落と区別し、同じAudioContext時計で既知PCMを渡す。
      const context = new AudioContext({ sampleRate: 48000 })
      const response = await fetch('/perfectPitch/output/test-dominant-second.wav')
      const buffer = await context.decodeAudioData(await response.arrayBuffer())
      const destination = context.createMediaStreamDestination()
      const source = context.createBufferSource()
      source.buffer = buffer
      source.connect(destination)
      const session = new CaptureSession(mode, {}, {
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
      await new Promise(resolve => setTimeout(resolve, 3800))
      const recording = await session.stop()
      return {
        notes: ['continuous', 'rounded'].map(pitchMode =>
          buildNotes(recording.frames, mode, pitchMode, recording.samples.length / recording.sampleRate)
            .map((note: { midi: number }) => Math.round(note.midi))),
      }
    }, mode)
    expect(result.notes).toEqual([[48, 48, 60], [48, 48, 60]])
  })
}
