import { test, expect } from '@playwright/test'

test('停止後は実進捗つきの分析中表示で待ち、モバイルでも操作が収まる', async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 812 })
  await page.goto('./')
  await page.evaluate(() => {
    const states: { phase: string; disabled: boolean }[] = []
    Object.assign(window, { analysisStates: states })
    new MutationObserver(() => states.push({
      phase: document.querySelector('#phase')!.textContent!,
      disabled: (document.querySelector('#record') as HTMLButtonElement).disabled,
    })).observe(document.querySelector('#phase')!, { childList: true, subtree: true, characterData: true })
  })
  await page.getByRole('button', { name: '録音する', exact: true }).click()
  await expect(page.locator('#phase')).toHaveText('録音中・暫定')
  await page.waitForTimeout(2600)
  await page.getByRole('button', { name: '録音を止める' }).click()
  await expect(page.locator('#phase')).toContainText('分析中')
  await expect(page.getByRole('button', { name: '音声を分析中' })).toBeDisabled()
  await expect(page.locator('#status')).toContainText('分析中')
  const bounds = await page.locator('#status').boundingBox()
  expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(375)
  await page.screenshot({ path: 'output/offline-analyzing-mobile.png', fullPage: true })
  await expect(page.locator('#phase')).toHaveText('録音済み')
  const states = await page.evaluate(() => (window as unknown as {
    analysisStates: { phase: string; disabled: boolean }[]
  }).analysisStates)
  const analyzing = states.filter(s => s.phase.startsWith('分析中'))
  expect(analyzing.length).toBeGreaterThan(1)
  expect(analyzing.every(s => s.disabled)).toBe(true)
  expect(analyzing.some(s => /分析中 [1-9]\d?%/.test(s.phase))).toBe(true)
  await expect(page.locator('#record')).toBeEnabled()
  await expect(page.locator('#play')).toBeEnabled()
})

test('停止後の分析失敗でも元音声を再生でき、再解析で復帰する', async ({ page }) => {
  await page.addInitScript(() => {
    const NativeWorker = window.Worker
    let failed = false
    window.Worker = class extends NativeWorker {
      postMessage(message: { type?: string }, transfer: Transferable[] = []): void {
        if (message.type === 'reanalyze' && !failed) {
          failed = true
          queueMicrotask(() => this.dispatchEvent(new MessageEvent('message', {
            data: { type: 'error', message: 'テスト用の分析失敗' },
          })))
        } else super.postMessage(message, transfer)
      }
    }
  })
  await page.goto('./')
  await page.getByRole('button', { name: '録音する', exact: true }).click()
  await page.waitForTimeout(1600)
  await page.getByRole('button', { name: '録音を止める' }).click()
  await expect(page.locator('#phase')).toHaveText('録音済み')
  await expect(page.locator('#status')).toContainText('元の声は再生できます')
  await page.locator('#play').click()
  await expect(page.locator('#phase')).toHaveText('再生中')
  await page.locator('#play').click()
  await page.getByText('再生・解析の設定', { exact: true }).click()
  await page.getByRole('button', { name: '元音声から再解析する' }).click()
  await expect(page.locator('#status')).toContainText('再解析しました')
  await expect(page.locator('#pitchSummary')).not.toContainText('有効な音程をまだ')
})
