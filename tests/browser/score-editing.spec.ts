import { test, expect } from '@playwright/test'

test('音符の修正・休符・UndoとMIDI保存が同じ五線譜に反映される', async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 812 })
  await page.goto('./')
  await page.evaluate(async () => {
    // @ts-expect-error Vite serves the browser module.
    const { mountScorePanel } = await import('/perfectPitch/src/ui/score-panel.ts')
    const panel = mountScorePanel(document.querySelector('#score')!)
    const frames = Array.from({ length: 200 }, (_, i) => {
      const midi = [60, 62, 64, 65][Math.floor(i / 50)]
      return { t: .005 + i / 100, midi, frequency: 440 * 2 ** ((midi - 69) / 12), rms: .1, periodicity: 1, state: 'voiced' }
    })
    panel.update(frames, 2, 'song')
  })
  await page.locator('#scoreDetails > summary').first().click()
  await page.getByText('音符を直す', { exact: true }).click()
  await page.getByLabel('音程', { exact: true }).selectOption('61')
  await page.getByRole('button', { name: '変更する', exact: true }).click()
  await expect(page.locator('#scoreMeasures')).toContainText('ド♯4')
  await page.getByRole('button', { name: '休符にする', exact: true }).click()
  await expect(page.locator('#scoreMeasures')).not.toContainText('ド♯4')
  await page.getByRole('button', { name: '元に戻す', exact: true }).click()
  await expect(page.locator('#scoreMeasures')).toContainText('ド♯4')
  await page.locator('#scoreTempo').fill('90')
  await expect(page.locator('#scoreMeasures')).toContainText('ド♯4')
  await expect(page.locator('#scoreTempoHint')).toContainText('音符の長さを保ち')
  await page.locator('#scoreTempo').fill('300')
  await expect(page.getByRole('button', { name: 'MIDIを保存', exact: true })).toBeDisabled()
  await page.locator('#scoreTempo').fill('90')
  const download = page.waitForEvent('download')
  await page.getByRole('button', { name: 'MIDIを保存', exact: true }).click()
  const file = await download
  expect(file.suggestedFilename()).toBe('perfectPitch.mid')
  const stream = await file.createReadStream()
  const chunks = []
  for await (const chunk of stream!) chunks.push(chunk)
  const bytes = Buffer.concat(chunks)
  expect(bytes.subarray(0, 4).toString()).toBe('MThd')
  expect(bytes.includes(Buffer.from([0x90, 61, 96]))).toBe(true)
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
  await page.screenshot({ path: 'output/service-quality/edit-mobile.png', fullPage: true })
})

test('声の種類を変えた再解析が失敗しても音符編集と成功済みの設定を保持する', async ({ page }) => {
  await page.addInitScript(() => {
    const NativeWorker = window.Worker
    let analyzed = false
    window.Worker = class extends NativeWorker {
      postMessage(message: { type?: string }, transfer: Transferable[] = []): void {
        if (message.type === 'reanalyze' && analyzed) {
          queueMicrotask(() => this.dispatchEvent(new MessageEvent('message', { data: { type: 'error', message: '制御した再解析失敗' } })))
          return
        }
        if (message.type === 'reanalyze') analyzed = true
        super.postMessage(message, transfer)
      }
    }
  })
  await page.goto('./')
  await page.locator('#audioFile').setInputFiles('output/test-voice.wav')
  await expect(page.locator('#status')).toContainText('読み込みました')
  await page.locator('#scoreDetails > summary').click()
  await page.locator('#scoreEditDetails > summary').click()
  await page.locator('#editPitch').selectOption('61')
  await page.locator('#applyNote').click()
  await page.locator('#scoreTempo').fill('90')
  // 解析失敗ですぐ元のradioへ戻るため、最終checkedを要求するcheckではなく実クリックする。
  await page.getByLabel('話し声', { exact: true }).click()
  await expect(page.locator('#status')).toContainText('制御した再解析失敗')
  await expect(page.getByLabel('歌声', { exact: true })).toBeChecked()
  await expect(page.locator('#scoreTempo')).toHaveValue('90')
  await expect(page.locator('#editPitch')).toHaveValue('61')
  await expect(page.locator('#undoScore')).toBeEnabled()
  await expect(page.locator('#scoreMeasures')).toContainText('ド♯4')
})
