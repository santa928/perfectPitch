import { test, expect } from '@playwright/test'

test('任意操作までモデルを取得せず、失敗から再試行でき、両推定の編集を保持する', async ({ page }) => {
  const modelRequests: string[] = [], uploads: string[] = []
  page.on('request', request => {
    if (/\/(models|runtime)\//.test(request.url())) modelRequests.push(request.url())
    if (request.method() !== 'GET') uploads.push(request.url())
  })
  await page.goto('./')
  await page.locator('#audioFile').setInputFiles('output/test-voice.wav')
  await expect(page.locator('#status')).toContainText('読み込みました')
  await page.locator('#scoreDetails > summary').click()
  await expect(page.locator('#scoreMeasures svg').first()).toBeVisible()
  expect(modelRequests).toEqual([])
  await page.locator('#scoreEditDetails > summary').click()
  await page.locator('#editPitch').selectOption('70')
  await page.locator('#applyNote').click()
  await expect(page.locator('#scoreMeasures')).toContainText('ラ♯4')
  const original = await page.locator('#scoreMeasures').textContent()
  await page.route('**/models/basic-pitch.onnx', route => route.abort())
  await page.locator('#transcribe').click()
  await expect(page.locator('#transcriptionStatus')).toContainText('直前の結果を保持')
  await expect(page.locator('#transcriptionStatus')).toHaveClass(/error/)
  await expect(page.locator('#scoreMeasures')).toHaveText(original!)
  await page.unroute('**/models/basic-pitch.onnx')
  await page.locator('#transcribe').click()
  await expect(page.locator('#transcriptionStatus')).toContainText('別の推定に切り替えました', { timeout: 20000 })
  await expect(page.locator('#melodyVersion')).toHaveValue('model')
  await page.locator('#editPitch').selectOption('61')
  await page.locator('#applyNote').click()
  await expect(page.locator('#scoreMeasures')).toContainText('ド♯4')
  const alternate = await page.locator('#scoreMeasures').textContent()
  await page.locator('#melodyVersion').selectOption('original')
  await expect(page.locator('#scoreMeasures')).toHaveText(original!)
  await page.locator('#melodyVersion').selectOption('model')
  await expect(page.locator('#scoreMeasures')).toHaveText(alternate!)
  expect(modelRequests.some(url => url.endsWith('.onnx'))).toBe(true)
  expect(modelRequests.every(url => url.startsWith('http://127.0.0.1:4173/'))).toBe(true)
  expect(uploads).toEqual([])
  await page.getByText('再生・解析の設定', { exact: true }).click()
  await page.locator('#reanalyze').click()
  await expect(page.locator('#status')).toContainText('再解析しました')
  await expect(page.locator('#melodyVersionLabel')).toBeHidden()
  await expect(page.locator('#transcribe')).toBeVisible()
})

test('再採譜中止でWorkerを解放し、元音声を再生できる', async ({ page }) => {
  await page.addInitScript(() => {
    const NativeWorker = window.Worker
    Object.assign(window, { startedTranscriptions: 0, stoppedTranscriptions: 0 })
    window.Worker = class extends NativeWorker {
      transcription = false
      postMessage(message: { type?: string }, transfer: Transferable[] = []): void {
        if (message.type === 'transcribe') {
          this.transcription = true
          ;(window as unknown as { startedTranscriptions: number }).startedTranscriptions++
          return
        }
        super.postMessage(message, transfer)
      }
      terminate(): void {
        if (this.transcription) (window as unknown as { stoppedTranscriptions: number }).stoppedTranscriptions++
        super.terminate()
      }
    }
  })
  await page.goto('./')
  await page.locator('#audioFile').setInputFiles('output/test-voice.wav')
  await expect(page.locator('#status')).toContainText('読み込みました')
  await page.locator('#scoreDetails > summary').click()
  await page.locator('#transcribe').click()
  await page.waitForFunction(() => (window as unknown as { startedTranscriptions: number }).startedTranscriptions === 1)
  await page.locator('#cancelTranscription').click()
  await expect(page.locator('#transcriptionStatus')).toContainText('中止しました')
  await page.locator('#play').click()
  await expect(page.locator('#phase')).toHaveText('再生中')
  await expect(page.locator('#melodyVersionLabel')).toBeHidden()
  expect(await page.evaluate(() => (window as unknown as { stoppedTranscriptions: number }).stoppedTranscriptions)).toBe(1)
})
