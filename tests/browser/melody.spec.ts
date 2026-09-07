import { test, expect } from '@playwright/test'

test('鼻歌の譜面を同じ音符で再生し、テンポ変更と録り直しで停止する', async ({ page }) => {
  await page.route('**/acoustic_grand_piano-mp3.js', route => route.fulfill({path:'output/piano.js',contentType:'text/plain'}))
  await page.goto('./')
  await page.locator('#record').click()
  await expect(page.locator('#phase')).toHaveText('録音中・暫定')
  await page.waitForTimeout(1800)
  await page.locator('#record').click()
  await expect(page.locator('#phase')).toHaveText('録音済み')
  await page.locator('#scoreDetails > summary').click()
  await expect(page.locator('#scorePlay')).toBeEnabled()
  const duration = await page.locator('#duration').textContent()
  await page.locator('#scorePlay').click()
  await expect(page.locator('#scorePlay')).toHaveText('■ 譜面再生を止める')
  await expect(page.locator('#scorePlaybackStatus')).toContainText('譜面どおり')
  await page.locator('#scoreTempo').fill('90')
  await expect(page.locator('#scorePlay')).toHaveText('▶ 譜面どおりに聴く')
  await expect(page.locator('#duration')).toHaveText(duration!)
  await page.locator('#scorePlay').click()
  await expect(page.locator('#scorePlay')).toHaveText('■ 譜面再生を止める')
  await page.locator('#play').click()
  await expect(page.locator('#phase')).toHaveText('再生中')
  await expect(page.locator('#scorePlay')).toHaveText('▶ 譜面どおりに聴く')
  await page.locator('#scorePlay').click()
  await expect(page.locator('#phase')).toHaveText('録音済み')
  await expect(page.locator('#scorePlay')).toHaveText('■ 譜面再生を止める')
  await page.locator('#record').click()
  await expect(page.locator('#score')).toBeHidden()
  await page.locator('#record').click()
  await expect(page.locator('#phase')).toHaveText('録音済み')
})

test('譜面音源の失敗は再試行でき、閉じると再生と読み込みを止める', async ({ page }) => {
  await page.goto('./')
  await page.evaluate(async () => {
    // @ts-expect-error Vite module for browser verification.
    const { mountScorePanel } = await import('/perfectPitch/src/ui/score-panel.ts')
    const host = document.querySelector<HTMLElement>('#score')!
    const panel = mountScorePanel(host)
    const frames=Array.from({length:200},(_,i)=>({t:.005+i/100,midi:60,frequency:261.63,rms:.1,periodicity:1,state:'voiced'}))
    panel.update(frames,2,'song')
  })
  await page.locator('#scoreDetails > summary').click()
  await page.route('**/acoustic_grand_piano-mp3.js', route => route.abort())
  await page.locator('#scorePlay').click()
  await expect(page.locator('#scorePlaybackStatus')).toContainText('再試行')
  await expect(page.locator('#record')).toBeEnabled()
  await page.unroute('**/acoustic_grand_piano-mp3.js')
  await page.route('**/acoustic_grand_piano-mp3.js', route => route.fulfill({path:'output/piano.js',contentType:'text/plain'}))
  await page.locator('#scorePlay').click()
  await expect(page.locator('#scorePlay')).toHaveText('■ 譜面再生を止める')
  await page.locator('#scoreDetails > summary').click()
  await page.locator('#scoreDetails > summary').click()
  await expect(page.locator('#scorePlay')).toHaveText('▶ 譜面どおりに聴く')
})

for (const width of [375,1280]) test(`鼻歌の譜面再生とテンポ案内が${width}pxで収まる`,async({page})=>{
  await page.setViewportSize({width,height:812})
  await page.goto('./')
  await page.evaluate(async()=>{
    // @ts-expect-error Vite module for browser verification.
    const {mountScorePanel}=await import('/perfectPitch/src/ui/score-panel.ts')
    const panel=mountScorePanel(document.querySelector('#score')!)
    const frames=Array.from({length:240},(_,i)=>{
      const midi=[60,62,64,65,64,62][Math.floor(i/40)]+.25*Math.sin(i*.35)
      return {t:.005+i/100,midi,frequency:440*2**((midi-69)/12),rms:.1,periodicity:1,state:'voiced'}
    })
    panel.update(frames,2.4,'song')
  })
  await page.locator('#scoreDetails > summary').click()
  await expect(page.locator('#scorePlay')).toBeEnabled()
  await expect(page.locator('#scoreTempoHint')).toContainText('テンポ候補')
  await expect(page.locator('#scoreMeasures svg').first()).toBeVisible()
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true)
  const bounds=await page.locator('.score-playback').evaluate(element=>{
    const parent=element.getBoundingClientRect()
    return [...element.children].map(child=>{const box=child.getBoundingClientRect();return {left:box.left-parent.left,right:parent.right-box.right,bottom:parent.bottom-box.bottom}})
  })
  for(const box of bounds){expect(box.left).toBeGreaterThanOrEqual(0);expect(box.right).toBeGreaterThanOrEqual(0);expect(box.bottom).toBeGreaterThanOrEqual(0)}
  await page.locator('#score').screenshot({path:`output/melody-${width}.png`})
})
