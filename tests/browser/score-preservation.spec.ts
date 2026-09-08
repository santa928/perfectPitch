import { test, expect, type Page } from '@playwright/test'
import { mkdirSync, writeFileSync } from 'node:fs'
import { parseMidi } from '../helpers/parse-midi.ts'
import { performanceNotes, scoreCases, syntheticWav } from '../helpers/score-fixtures.ts'

for (const count of [0, 100]) test(`検出${count}音・発音なしの再生可否と追加案内が一致する`, async ({ page }) => {
  // 検出だけを固定し、製品のScore変換・panel・編集器をそのまま通す。
  await page.route('**/src/analysis/melody.ts', route => route.fulfill({ contentType: 'text/javascript', body: `
    export function extractMelody() { return Array.from({length: ${count}}, (_, i) => ({start: i / 10000, end: (i + 1) / 10000, midi: 60, contour: []})) }
    export function suggestTempo() { return { bpm: 120, reliable: false, alternatives: [] } }
  ` }))
  await page.goto('./')
  await page.evaluate(async () => {
    const { mountScorePanel } = await import('/perfectPitch/src/ui/score-panel.ts')
    const host = document.querySelector<HTMLElement>('#score')!
    const panel = mountScorePanel(host)
    panel.update([], 1, 'song')
  })
  await page.locator('#scoreDetails > summary').click()
  await expect(page.locator('#scorePlay')).toBeDisabled()
  await expect(page.locator('#scorePlaybackStatus')).toContainText('再生できる音符がありません')
  await page.locator('#scoreEditDetails > summary').click()
  if (count === 0) {
    await expect(page.locator('#scorePlaybackStatus')).not.toContainText('追加できます')
    await expect(page.locator('#insertNote')).toBeDisabled()
    return
  }
  await expect(page.locator('#scoreStatus')).toContainText('100個は未配置')
  await page.locator('#insertNote').click()
  await expect(page.locator('#scorePlay')).toBeEnabled()
  await expect(page.locator('#scorePlaybackStatus')).toContainText('五線譜にある音符をピアノで聴けます')
  await expect(page.locator('#scoreStatus')).toContainText('100個は未配置')
})

/** ダウンロードしたバイト列をwriterとは独立したSMF parserへ渡す。 */
async function downloadMidi(page: Page) {
  const pending = page.waitForEvent('download')
  await page.locator('#saveMidi').click()
  const stream = await (await pending).createReadStream(), chunks: Buffer[] = []
  for await (const chunk of stream!) chunks.push(chunk as Buffer)
  return parseMidi(Buffer.concat(chunks))
}

/** 通常のWeb Audio再生を維持したまま、実際のsource.start予約を観測する。 */
async function observePiano(page: Page): Promise<void> {
  await page.route('https://gleitz.github.io/**/acoustic_grand_piano-mp3.js', route => route.fulfill({ path: 'output/piano.js', contentType: 'text/javascript' }))
  await page.addInitScript(() => {
    const starts: { when: number; rate: number; loop: boolean }[] = []
    Object.assign(window, { scoreVoiceStarts: starts })
    const original = AudioBufferSourceNode.prototype.start
    AudioBufferSourceNode.prototype.start = function(...args: Parameters<typeof original>) {
      starts.push({ when: args[0] ?? 0, rate: this.playbackRate.value, loop: this.loop })
      return original.apply(this, args)
    }
  })
}

for (const width of [375, 1280]) {
  test(`${width}px: 決定的な短音・同音・長音の表示、選択、編集、再生、MIDI`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 })
    await observePiano(page)
    for (const fixture of scoreCases) {
      await page.goto('./')
      const state = await page.evaluate(async ({ input, duration }) => {
        const { buildScore } = await import('/perfectPitch/src/notation/score.ts')
        const { scoreToPiano } = await import('/perfectPitch/src/notation/score-playback.ts')
        const { ScoreEditor } = await import('/perfectPitch/src/notation/score-editor.ts')
        const { renderMeasures } = await import('/perfectPitch/src/ui/score-renderer.ts')
        const { mountScoreEditor } = await import('/perfectPitch/src/ui/score-editor-panel.ts')
        const { VoicePlayer } = await import('/perfectPitch/src/audio/player.ts')
        const host = document.querySelector<HTMLElement>('#score')!
        host.hidden = false
        host.innerHTML = '<div class="score-details"><div id="fixtureMeasures" class="score-measures"></div><button id="fixturePlay">譜面を聴く</button><p id="fixturePlaying"></p><div id="fixtureEditor"></div></div>'
        const editor = new ScoreEditor(buildScore(input, duration, 120)), player = new VoicePlayer()
        const render = () => renderMeasures(document.querySelector('#fixtureMeasures')!, editor.score.measures, 0,
          { ppq: editor.ppq, onSelect: tick => controls.select(tick) })
        const controls = mountScoreEditor(document.querySelector('#fixtureEditor')!, { editor: () => editor, onChange: () => { void render() } })
        document.querySelector('#fixturePlay')!.addEventListener('click', async () => {
          const schedule = scoreToPiano(editor.score)
          await player.play(new Float32Array(0), 48000, schedule.notes, 0, schedule.duration)
          document.querySelector('#fixturePlaying')!.textContent = '再生中'
        })
        await render()
        return { events: editor.score.measures.flat(), piano: scoreToPiano(editor.score) }
      }, { input: performanceNotes(fixture.notes), duration: fixture.duration })
      const labels = await page.locator('#fixtureMeasures svg').evaluateAll(svgs => svgs.flatMap(svg =>
        svg.getAttribute('aria-label')!.split('。')[1].split('、').filter(s => s !== '休符' && !s.startsWith('継続'))))
      expect(labels).toEqual(fixture.pitches.map(midi => midi === 62 ? 'レ4' : 'ド4'))
      expect(await page.locator('#editNote option').count()).toBe(fixture.pitches.length)
      expect(state.piano.notes.map((n: { midi: number }) => n.midi)).toEqual(fixture.pitches)
      let midi = await downloadMidi(page)
      expect(midi.events.filter(e => e.status === 0x90).map(e => e.data[0])).toEqual(fixture.pitches)
      const targetId = fixture.id === 'long' ? 0 : 1
      const pieceIndex = state.events.filter((e: { midi: number | null }) => e.midi !== null).findIndex((e: { sourceId?: number }) => e.sourceId === targetId)
      await page.locator('#fixtureMeasures [role="button"]').nth(pieceIndex).click()
      await expect(page.locator('#editNote')).toHaveValue(String(targetId))
      await expect(page.locator('#scoreEditDetails')).toHaveAttribute('open', '')
      await page.locator('#editPitch').selectOption('61')
      await page.locator('#applyNote').click()
      await expect(page.locator('#fixtureMeasures')).toContainText('ド♯4')
      midi = await downloadMidi(page)
      expect(midi.events.filter(e => e.status === 0x90)[targetId].data[0]).toBe(61)
      await page.locator('#undoScore').click()
      await expect(page.locator('#fixtureMeasures')).not.toContainText('ド♯4')
      await page.locator('#redoScore').click()
      await expect(page.locator('#fixtureMeasures')).toContainText('ド♯4')
      await page.locator('#undoScore').click()
      const fields = await Promise.all(['editMeasure', 'editBeat', 'editLength', 'editPitch'].map(id => page.locator(`#${id}`).inputValue()))
      await page.locator('#removeNote').click()
      for (const [i, id] of ['editMeasure', 'editBeat', 'editLength'].entries()) await page.locator(`#${id}`).fill(fields[i])
      await page.locator('#editPitch').selectOption(fields[3])
      await page.locator('#insertNote').click()
      await expect(page.locator('#resetScore')).toBeEnabled()
      await page.locator('#resetScore').click()
      midi = await downloadMidi(page)
      expect(midi.events.filter(e => e.status === 0x90).map(e => e.data[0])).toEqual(fixture.pitches)
      await page.locator('#fixturePlay').click()
      await expect(page.locator('#fixturePlaying')).toHaveText('再生中')
      const starts = await page.evaluate(() => (window as unknown as { scoreVoiceStarts: { when: number; rate: number; loop: boolean }[] }).scoreVoiceStarts)
      expect(starts).toHaveLength(fixture.pitches.length)
      expect(starts.every(n => n.rate === 1 && !n.loop)).toBe(true)
      for (let i = 0; i < starts.length; i++) expect(starts[i].when - starts[0].when).toBeCloseTo(state.piano.notes[i].start, 6)
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
      const geometry = await page.locator('#fixtureMeasures svg').evaluateAll(svgs => svgs.map(element => {
        const svg = element as SVGSVGElement, box = svg.getBBox(), view = svg.viewBox.baseVal
        return { right: view.x + view.width - box.x - box.width, bottom: view.y + view.height - box.y - box.height }
      }))
      expect(geometry.every(box => box.right >= 0 && box.bottom >= 12)).toBe(true)
      await page.locator('#score').screenshot({ path: `output/issue22/browser/${fixture.id}-${width}.png` })
      if (width === 375) {
        await page.locator('#fixtureMeasures [role="button"]').last().click()
        await expect(page.locator('#editNote')).toHaveValue(String(fixture.pitches.length - 1))
        await page.locator('#score').screenshot({ path: `output/issue22/browser/${fixture.id}-${width}-end.png` })
      }
    }
  })

  test(`${width}px: 通常ファイル入力の短い合成C-D-Cは検出とScore変換を分けて検証する`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 })
    await observePiano(page)
    await page.addInitScript(() => {
      const Native = Worker
      window.Worker = class extends Native {
        constructor(...args: ConstructorParameters<typeof Worker>) {
          super(...args)
          this.addEventListener('message', event => { if (event.data.type === 'done') Object.assign(window, { scoreInputFrames: event.data.frames }) })
        }
      }
    })
    await page.goto('./')
    const input = performanceNotes([[.4, .6, 60], [.6, .7, 62], [.7, 1.4, 60]])
    await page.locator('#audioFile').setInputFiles({ name: 'synthetic-cdc.wav', mimeType: 'audio/wav', buffer: syntheticWav(input, 1.8) })
    await expect(page.locator('#status')).toContainText('読み込みました')
    await page.locator('#scoreDetails > summary').click()
    await page.locator('#scoreTempo').fill('120')
    await expect(page.locator('#scoreMeasures svg')).toHaveCount(1)
    const stages = await page.evaluate(async () => {
      const { extractMelody } = await import('/perfectPitch/src/analysis/melody.ts')
      const { buildScore } = await import('/perfectPitch/src/notation/score.ts')
      const { scoreToPiano } = await import('/perfectPitch/src/notation/score-playback.ts')
      const notes = extractMelody((window as unknown as { scoreInputFrames: unknown[] }).scoreInputFrames, 1.8)
      const score = buildScore(notes, 1.8, 120)
      return { notes, score, piano: scoreToPiano(score) }
    })
    const midi = await downloadMidi(page)
    expect(midi.events.filter(e => e.status === 0x90).map(e => e.data[0])).toEqual(stages.notes.map((n: { midi: number }) => n.midi))
    expect(stages.piano.notes.map((n: { midi: number }) => n.midi)).toEqual(stages.notes.map((n: { midi: number }) => n.midi))
    expect(stages.score.omittedNotes).toBe(0)
    await page.locator('#scorePlay').click()
    await expect(page.locator('#scorePlaybackStatus')).toContainText('再生しています')
    const starts = await page.evaluate(() => (window as unknown as { scoreVoiceStarts: unknown[] }).scoreVoiceStarts.length)
    expect(starts).toBe(stages.notes.length)
    mkdirSync('output/issue22/browser', { recursive: true })
    writeFileSync(`output/issue22/browser/audio-stages-${width}.json`, JSON.stringify({ syntheticExpected: [60, 62, 60], ...stages }, null, 2))
    await page.locator('#score').screenshot({ path: `output/issue22/browser/audio-${width}.png` })
  })
}

test('60秒600音の描画・末尾選択・編集・MIDIがブラウザでも完了する', async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 900 })
  await page.goto('./')
  const result = await page.evaluate(async () => {
    const { buildScore } = await import('/perfectPitch/src/notation/score.ts')
    const { ScoreEditor } = await import('/perfectPitch/src/notation/score-editor.ts')
    const { renderMeasures } = await import('/perfectPitch/src/ui/score-renderer.ts')
    const { mountScoreEditor } = await import('/perfectPitch/src/ui/score-editor-panel.ts')
    const input = Array.from({ length: 600 }, (_, i) => ({ start: i / 10, end: (i + .7) / 10, midi: 48 + i % 25, contour: [] }))
    const editor = new ScoreEditor(buildScore(input, 60, 240)), host = document.querySelector<HTMLElement>('#score')!
    host.hidden = false; host.innerHTML = '<div id="denseMeasures" class="score-measures"></div><div id="denseEditor"></div>'
    const start = performance.now()
    const panel = mountScoreEditor(document.querySelector('#denseEditor')!, { editor: () => editor, onChange: () => {} })
    await renderMeasures(document.querySelector('#denseMeasures')!, editor.score.measures.slice(-4), 56, { ppq: editor.ppq, onSelect: tick => panel.select(tick) })
    panel.select(editor.notes.at(-1)!.tick)
    return { renderMs: performance.now() - start, notes: editor.notes.length }
  })
  await page.locator('#editPitch').selectOption('72')
  await page.locator('#applyNote').click()
  await expect(page.locator('#scoreEditStatus')).toContainText('変更しました')
  const midi = await downloadMidi(page)
  expect(midi.events.filter(e => e.status === 0x90)).toHaveLength(result.notes)
  expect(midi.events.filter(e => e.status === 0x90).at(-1)!.data[0]).toBe(72)
  expect(result.renderMs).toBeLessThan(5000)
  writeFileSync('output/issue22/browser/dense.json', JSON.stringify(result))
})
