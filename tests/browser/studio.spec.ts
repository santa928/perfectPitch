import { test, expect } from '@playwright/test'
import { resolve } from 'node:path'

test('録音から再解析・原音再生・停止・歌/話の切替まで実際の音声経路が動く', async ({
  page,
}) => {
  const errors: string[] = []
  page.on('pageerror', (error) => errors.push(error.message))
  await page.goto('./')
  await expect(
    page.getByRole('heading', { name: /鼻歌から、.*ピアノと楽譜へ。/ }),
  ).toBeVisible()
  await expect(
    page.getByRole('button', { name: '再生する', exact: false }),
  ).toBeHidden()
  const initialRecord = await page.locator('#record').boundingBox()
  expect(initialRecord!.y + initialRecord!.height).toBeLessThanOrEqual(720)
  await page.getByRole('button', { name: '録音する', exact: true }).click()
  await expect(page.getByRole('button', { name: '録音を止める' })).toBeVisible()
  await page.waitForTimeout(2700)
  await page.getByRole('button', { name: '録音を止める' }).click()
  await expect(page.locator('#phase')).toHaveText('録音済み')
  await expect(page.locator('#micSettings')).toContainText('PCM mono')
  await expect(page.locator('#pitchSummary')).not.toContainText(
    '有効な音程をまだ',
  )
  await page.getByRole('button', { name: '再生する', exact: false }).click()
  await expect(page.locator('#phase')).toHaveText('再生中')
  await page.waitForTimeout(350)
  expect(Number(await page.locator('#seek').inputValue())).toBeGreaterThan(0.15)
  await page.getByRole('button', { name: '再生を止める' }).click()
  await expect(page.locator('#phase')).toHaveText('録音済み')
  await page.getByText('再生・解析の設定', { exact: true }).click()
  await page.getByRole('button', { name: '元音声から再解析する' }).click()
  await expect(page.locator('#status')).toContainText('再解析しました')
  await page.locator('input[value="speech"]').check()
  await expect(page.locator('#status')).toContainText('再解析しました')
  await expect(page.locator('#pitchMode')).toHaveValue('continuous')
  await expect(page.locator('#pitchHelp')).toContainText('細かな揺れを残す')
  await page.locator('#pitchMode').selectOption('rounded')
  await expect(page.locator('#pitchHelp')).toContainText('近くの半音へ丸めます')
  await page.locator('#pitchMode').selectOption('continuous')
  await page.locator('#scoreDetails summary').click()
  await expect(page.locator('#scoreMeasures svg').first()).toBeVisible()
  for (const href of await page.locator('.score-credits a').evaluateAll((links) => links.map((link) => (link as HTMLAnchorElement).href))) {
    const response = await page.request.get(href)
    expect(response.ok()).toBe(true)
    expect(await response.text()).toMatch(/Permission is hereby granted|SIL OPEN FONT LICENSE/)
  }
  await expect(page.locator('#scoreStatus')).toContainText('最初の検出音')
  const recordingLength = await page.locator('#seek').getAttribute('max')
  await page.locator('#scoreTempo').fill('80')
  await expect(page.locator('#scoreStatus')).toContainText('最初の検出音')
  expect(await page.locator('#seek').getAttribute('max')).toBe(recordingLength)
  await page.locator('#scoreTempo').fill('')
  await expect(page.locator('#scoreStatus')).toContainText('40〜240')
  await expect(page.locator('#play')).toBeEnabled()
  await page.locator('#scoreTempo').fill('120')
  await expect(page.locator('#scoreMeasures svg').first()).toBeVisible()
  await page.screenshot({ path: 'output/studio-desktop.png', fullPage: true })
  expect(errors).toEqual([])
})

test('音源失敗を明示して再試行し、ピアノから録音へ切替時に再生を止める', async ({
  page,
}) => {
  await page.goto('./')
  await page.getByRole('button', { name: '録音する', exact: true }).click()
  await expect(page.locator('#phase')).toHaveText('録音中・暫定')
  await page.waitForTimeout(2400)
  await page.getByRole('button', { name: '録音を止める' }).click()
  await expect(page.locator('#phase')).toHaveText('録音済み')
  await page.locator('input[value="piano"]').check()
  await page.route('**/acoustic_grand_piano-mp3.js', (route) => route.abort())
  await page.locator('#play').click()
  await expect(page.locator('#status')).toContainText('再試行')
  await expect(page.locator('#phase')).toHaveText('録音済み')
  await page.unroute('**/acoustic_grand_piano-mp3.js')
  // Licensed, unchanged upstream soundfont cached locally for reproducible decoding.
  await page.route('**/acoustic_grand_piano-mp3.js', (route) =>
    route.fulfill({
      path: resolve('output/piano.js'),
      contentType: 'text/javascript',
    }),
  )
  await page.locator('#play').click()
  await expect(page.locator('#phase')).toHaveText('再生中')
  await page.getByRole('button', { name: 'もう一度録音する' }).click()
  await expect(page.locator('#phase')).toHaveText('録音中・暫定')
  await expect(page.locator('#review')).toBeHidden()
  await page.getByRole('button', { name: '録音を止める' }).click()
  await expect(page.locator('#phase')).toHaveText('録音済み')
})

test('モバイル幅で主要操作が収まり、許可拒否から復帰できる', async ({
  page,
}) => {
  await page.setViewportSize({ width: 375, height: 812 })
  await page.addInitScript(() => {
    navigator.mediaDevices.getUserMedia = async () => {
      throw new DOMException('denied', 'NotAllowedError')
    }
  })
  await page.goto('./')
  await page.getByRole('button', { name: '録音する', exact: true }).click()
  await expect(page.locator('#status')).toHaveClass(/error/)
  await expect(
    page.getByRole('button', { name: '録音する', exact: true }),
  ).toBeEnabled()
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true)
  const box = await page.locator('#record').boundingBox()
  expect(box!.x).toBeGreaterThanOrEqual(0)
  expect(box!.x + box!.width).toBeLessThanOrEqual(375)
  expect(box!.y + box!.height).toBeLessThanOrEqual(812)

  await page.screenshot({ path: 'output/studio-mobile.png', fullPage: true })
})

test('許可待ちキャンセル後に遅れたマイク取得を破棄する', async ({ page }) => {
  await page.addInitScript(() => {
    const original = navigator.mediaDevices.getUserMedia.bind(
      navigator.mediaDevices,
    )
    navigator.mediaDevices.getUserMedia = async (constraints) => {
      const stream = await original(constraints)
      await new Promise((resolve) => setTimeout(resolve, 700))
      return stream
    }
  })
  await page.goto('./')
  await page.getByRole('button', { name: '録音する', exact: true }).click()
  await page.getByRole('button', { name: 'マイク準備をキャンセル' }).click()
  await page.waitForTimeout(1000)
  await expect(page.locator('#phase')).toHaveText('録音前')
  await expect(page.locator('#status')).toContainText('キャンセル')
})

test('描画が停止してもPCM録音が進み、背景化通知で停止して勝手に再開しない', async ({
  page,
}) => {
  await page.goto('./')
  await page.locator('#record').click()
  await expect(page.locator('#phase')).toHaveText('録音中・暫定')
  await page.evaluate(() => {
    window.requestAnimationFrame = () => 1
  })
  await page.waitForTimeout(2100)
  await expect(page.locator('#duration')).toContainText('0:02')
  await page.evaluate(() => {
    Object.defineProperty(document, 'hidden', {
      configurable: true,
      get: () => true,
    })
    document.dispatchEvent(new Event('visibilitychange'))
  })
  await expect(page.locator('#phase')).toHaveText('録音済み')
  await expect(page.locator('#status')).toContainText('画面を離れたため')
  await page.evaluate(() => {
    Object.defineProperty(document, 'hidden', {
      configurable: true,
      get: () => false,
    })
    document.dispatchEvent(new Event('visibilitychange'))
  })
  await expect(page.locator('#phase')).toHaveText('録音済み')
  await page.locator('input[value="piano"]').check({ force: true })
  await expect(page.locator('#play')).toBeEnabled()
})
