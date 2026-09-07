import { test, expect } from '@playwright/test'

test('短い低音の検出列を受けた実画面で、軌跡と音名は補正し100ms低音は残す', async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 812 })
  // 撮影時のPCMは未提供のため、Worker出力だけを既知の検出列へ置換する。
  // 録音UI・表示用の補正・Canvas・音名・楽譜は本番モジュールを通す。
  const frames = Array.from({ length: 200 }, (_, i) => {
    const midi = i >= 80 && i < 82 ? 41.2 : i >= 120 && i < 130 ? 48.2 : 60.2
    return { t: i * .01, midi, frequency: 440 * 2 ** ((midi - 69) / 12), rms: .1, periodicity: .99, state: 'voiced' }
  })
  await page.route('**/src/audio/analysis-worker.ts*', route => route.fulfill({
    contentType: 'text/javascript',
    body: `self.onmessage = ({data}) => { if (data.type === 'reanalyze') self.postMessage({type: 'done', frames: ${JSON.stringify(frames)}}); };`,
  }))
  await page.goto('./')
  await page.locator('input[name="voiceMode"][value="speech"]').check()
  await page.locator('#record').click()
  await expect(page.locator('#phase')).toHaveText('録音中・暫定')
  await page.waitForTimeout(2200)
  await page.locator('#record').click()
  await expect(page.locator('#phase')).toHaveText('録音済み')
  for (const [time, label] of [[.805, 'C4'], [1.25, 'C3']] as const) {
    await page.locator('#seek').evaluate((element, time) => {
      const seek = element as HTMLInputElement
      seek.value = String(time)
      seek.dispatchEvent(new Event('input', { bubbles: true }))
    }, time)
    await expect(page.locator('#pitchSummary')).toContainText(label)
  }
  // 青い軌跡の下端を実Canvas画素から検査。D2の急落は消え、C3は残る。
  const lowest = await page.locator('canvas').evaluate(canvas => {
    const context = canvas.getContext('2d')!
    const { data } = context.getImageData(0, 0, canvas.width, canvas.height)
    let bottom = -1
    for (let i = 0; i < data.length; i += 4)
      if (data[i] === 30 && data[i + 1] === 100 && data[i + 2] === 190 && data[i + 3] > 200)
        bottom = Math.max(bottom, Math.floor(i / 4 / canvas.width))
    const height = canvas.getBoundingClientRect().height
    return { bottom: bottom / devicePixelRatio, expected: height - 30 - (48.2 - 33) / 50 * (height - 52) }
  })
  expect(Math.abs(lowest.bottom - lowest.expected)).toBeLessThan(3)
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
  await page.locator('canvas').screenshot({ path: 'output/continuity-mobile.png' })
  await page.locator('#scoreDetails > summary').click()
  // 120 BPMでは100ms音が既存の16分量子化で消える位相なので、表示分解能を上げる。
  await page.locator('#scoreTempo').fill('240')
  await expect(page.locator('#scoreMeasures svg').first()).toBeVisible()
  await expect(page.locator('#scoreMeasures')).not.toContainText('レ2')
  await expect(page.locator('#scoreMeasures')).toContainText('ド3')
})
