import { test, expect } from '@playwright/test'

/** 既定は冒頭から発声するWAV。先頭無音/微小音も同じ実ファイル入力で検証する。 */
function voice(seconds = 1, amplitude = 8000, silentLead = 0): Buffer {
  const rate = 16000, frames = Math.round(rate * seconds)
  const wav = Buffer.alloc(44 + frames * 2)
  wav.write('RIFF'); wav.writeUInt32LE(wav.length - 8, 4); wav.write('WAVEfmt ', 8)
  wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22)
  wav.writeUInt32LE(rate, 24); wav.writeUInt32LE(rate * 2, 28)
  wav.writeUInt16LE(2, 32); wav.writeUInt16LE(16, 34); wav.write('data', 36)
  wav.writeUInt32LE(frames * 2, 40)
  for (let i = 0; i < frames; i++) wav.writeInt16LE(i < silentLead * rate ? 0 :
    Math.round(amplitude * Math.sin(2 * Math.PI * 220 * i / rate)), 44 + i * 2)
  return wav
}

test('ファイルの冒頭を解析し、原音・五線譜へ進める。対応外でも直前の結果を保持する', async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 812 })
  const uploaded: string[] = []
  page.on('request', request => { if (request.method() !== 'GET') uploaded.push(request.url()) })
  await page.goto('./')
  await page.locator('#audioFile').setInputFiles({ name: '鼻歌.wav', mimeType: 'audio/wav', buffer: voice() })
  await expect(page.locator('#status')).toContainText('読み込みました')
  await expect(page.locator('#play')).toBeEnabled()
  await page.locator('#scoreDetails > summary').click()
  await expect(page.locator('#scoreMeasures')).toContainText('ラ3')
  await expect(page.locator('#scoreStatus')).toContainText(/0\.0[34]秒/)
  await page.locator('#scoreTempo').fill('90')
  await expect(page.locator('#scoreTempoHint')).toContainText('初期値は仮の120')
  await page.locator('#audioFile').setInputFiles({ name: '壊れた音声.m4a', mimeType: 'audio/mp4', buffer: Buffer.from('invalid audio') })
  await expect(page.locator('#status')).toHaveClass(/error/)
  await expect(page.locator('#duration')).toHaveText('0:01 / 1:00')
  await expect(page.locator('#scoreTempo')).toHaveValue('90')
  await page.locator('#play').click()
  await expect(page.locator('#phase')).toHaveText('再生中')
  await page.locator('#play').click()
  expect(uploaded).toEqual([])
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
  await page.screenshot({ path: 'output/service-quality/import-mobile.png', fullPage: true })
})

test('先頭無音付きの微小周期音ファイルを音符化せず、原音は保持する', async ({ page }) => {
  await page.goto('./')
  await page.locator('#audioFile').setInputFiles({ name: 'quiet-hum.wav', mimeType: 'audio/wav',
    buffer: voice(1.4, 49, .4) })
  await expect(page.locator('#status')).toContainText('読み込みました')
  await expect(page.locator('#play')).toBeEnabled()
  await page.locator('#scoreDetails > summary').click()
  await expect(page.locator('#scoreStatus')).toContainText('楽譜にできる音程を検出していません')
})

test('長すぎるファイルを拒否し、解析を中止して遅い結果を破棄する', async ({ page }) => {
  await page.addInitScript(() => {
    const NativeWorker = window.Worker
    window.Worker = class extends NativeWorker {
      postMessage(message: { type?: string }, transfer: Transferable[] = []): void {
        if (message.type === 'reanalyze') return // 応答しないWorkerを中止できることを検査
        super.postMessage(message, transfer)
      }
    }
  })
  await page.goto('./')
  await page.locator('#audioFile').setInputFiles({ name: '61seconds.wav', mimeType: 'audio/wav', buffer: voice(61) })
  await expect(page.locator('#status')).toContainText('60秒')
  await expect(page.locator('#status')).toHaveClass(/error/)
  await page.locator('#audioFile').setInputFiles({ name: 'voice.wav', mimeType: 'audio/wav', buffer: voice() })
  await expect(page.locator('#phase')).toContainText('分析中')
  await page.getByRole('button', { name: '読み込みを中止', exact: true }).click()
  await expect(page.locator('#status')).toContainText('中止')
  await expect(page.locator('#record')).toBeEnabled()
  await expect(page.locator('#score')).toBeHidden()
})
