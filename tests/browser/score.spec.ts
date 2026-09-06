import { test, expect } from '@playwright/test'

test('楽譜モジュールの取得失敗は録音・原音再生を妨げない', async ({ page }) => {
  await page.goto('./')
  await page.locator('#record').click()
  await expect(page.locator('#phase')).toHaveText('録音中・暫定')
  await page.waitForTimeout(1600)
  await page.locator('#record').click()
  await expect(page.locator('#phase')).toHaveText('録音済み')
  await page.route(/\/score-renderer(?:\.ts|-[^/]+\.js)(?:\?.*)?$/, (route) => route.abort())
  await page.locator('#scoreDetails summary').click()
  await expect(page.locator('#scoreStatus')).toContainText('楽譜を表示できませんでした')
  await expect(page.locator('#record')).toBeEnabled()
  await page.locator('#play').click()
  await expect(page.locator('#phase')).toHaveText('再生中')
})

for (const width of [375, 1280]) {
  test(`五線譜の低高音・半音・密集したカタカナが${width}pxで収まる`, async ({ page }) => {
    await page.setViewportSize({ width, height: 812 })
    const external: string[] = []
    page.on('request', (request) => {
      if (!request.url().startsWith('http://127.0.0.1:4173')) external.push(request.url())
    })
    await page.goto('./')
    // 実データ採譜の精度とは分け、専用レンダラーの範囲・配置を既知の音符で検査する。
    await page.evaluate(async () => {
      // @ts-expect-error Vite serves the browser module.
      const { buildScore } = await import('/perfectPitch/src/notation/score.ts')
      // @ts-expect-error Vite serves the browser module.
      const { renderMeasures } = await import('/perfectPitch/src/ui/score-renderer.ts')
      const host = document.querySelector<HTMLElement>('#score')!
      host.hidden = false
      host.innerHTML = '<div class="score-details"><div id="fixtureScore" class="score-measures"></div></div>'
      const pitches = [33, 83, 61, 60, 66, 66, 65, 68, 70, 72, 73, 74, 75, 76, 77, 78]
      const input = pitches.map((midi, i) => ({ start: i / 8, end: (i + 1) / 8, midi, contour: [] }))
      input.push({ start: 2, end: 4.5, midi: 33, contour: [] })
      const score = buildScore(input, 5, 120)
      await renderMeasures(document.querySelector('#fixtureScore')!, score.measures, 0)
    })
    await expect(page.locator('.score-measures svg')).toHaveCount(3)
    await expect(page.locator('.score-measures')).toContainText('ド♯4')
    await expect(page.locator('.score-measures')).toContainText('ラ1')
    const geometry = await page.locator('.score-measures svg').evaluateAll((svgs) => svgs.map((element) => {
      const svg = element as SVGSVGElement
      const box = svg.getBBox()
      const view = svg.viewBox.baseVal
      return { left: box.x - view.x, top: box.y - view.y, right: view.x + view.width - box.x - box.width, bottom: view.y + view.height - box.y - box.height }
    }))
    for (const box of geometry) {
      expect(box.left).toBeGreaterThanOrEqual(0)
      expect(box.right).toBeGreaterThanOrEqual(0)
      expect(box.top).toBeGreaterThanOrEqual(0)
      expect(box.bottom).toBeGreaterThanOrEqual(12)
    }
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
    const labels = await page.locator('.score-measures svg').first().locator('.vf-annotation').evaluateAll((nodes) => nodes.map((node) => {
      const box = node.getBoundingClientRect()
      return { left: box.left, right: box.right, top: box.top }
    }))
    for (let i = 1; i < labels.length; i++) {
      expect(Math.abs(labels[i].top - labels[0].top)).toBeLessThan(1)
      expect(labels[i].left - labels[i - 1].right).toBeGreaterThanOrEqual(2)
    }
    expect(external).toEqual([])
    await page.locator('#score').screenshot({ path: `output/score-${width}.png` })
  })
}

test('楽譜パネルが再解析・録り直しで古い結果を消し、全小節をページ送りできる', async ({ page }) => {
  await page.goto('./')
  await page.evaluate(async () => {
    // @ts-expect-error Vite serves the browser module.
    const { mountScorePanel } = await import('/perfectPitch/src/ui/score-panel.ts')
    const host = document.querySelector<HTMLElement>('#score')!
    const panel = mountScorePanel(host)
    const frames = Array.from({ length: 6000 }, (_, i) => ({ t: i / 100, midi: 60, frequency: 261.63, rms: 0.1, periodicity: 1, state: 'voiced' }))
    panel.update(frames, 60, 'song')
    Object.assign(window, { fixturePanel: panel })
  })
  await page.locator('#scoreDetails summary').click()
  await expect(page.locator('#scorePage')).toHaveText('1〜4 / 30小節')
  await expect(page.locator('#scorePrevious')).toBeDisabled()
  await page.locator('#scoreNext').click()
  await expect(page.locator('#scorePage')).toHaveText('5〜8 / 30小節')
  await page.locator('#scorePrevious').click()
  await expect(page.locator('#scorePage')).toHaveText('1〜4 / 30小節')
  await page.locator('#scoreTempo').fill('240')
  await expect(page.locator('#scorePage')).toHaveText('1〜4 / 60小節')
  for (let i = 0; i < 14; i++) {
    await page.locator('#scoreNext').click()
    await expect(page.locator('#scorePage')).toHaveText(`${(i + 1) * 4 + 1}〜${(i + 2) * 4} / 60小節`)
  }
  await expect(page.locator('#scoreNext')).toBeDisabled()
  await page.evaluate(() => {
    // @ts-expect-error Test-only panel handle, not shipped in app.
    window.fixturePanel.update([], 1, 'song')
  })
  await expect(page.locator('#scoreStatus')).toContainText('検出していません')
  await expect(page.locator('#scoreMeasures svg')).toHaveCount(0)
  await page.evaluate(() => {
    // @ts-expect-error Test-only panel handle, not shipped in app.
    window.fixturePanel.update(null, 0, 'song')
  })
  await expect(page.locator('#score')).toBeHidden()
})
