/** 合成原音符の旧新譜面・MIDI・製品ピアノ経路のPCMをローカル成果物へ出力する。 */
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { chromium } from '@playwright/test'
import { createServer } from 'vite'
import { hash } from './contract.ts'
import { pcmWav, performanceNotes, scoreCases } from '../../tests/helpers/score-fixtures.ts'
import { parseMidi } from '../../tests/helpers/parse-midi.ts'

const destination = process.argv[2], baseline = process.argv[3]
if (!destination || !baseline || !resolve(destination).startsWith(resolve('output/issue22') + '/') || existsSync(destination))
  throw new Error('指定: 新規output/issue22/成果物先 output内の旧コードroot')
mkdirSync(destination, { recursive: true })
const server = await createServer({ server: { host: '127.0.0.1', port: 4173, strictPort: true } })
await server.listen()
const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] })
const records = []
try {
  for (const fixture of scoreCases) for (const variant of ['before', 'after'] as const) {
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 } })
    await page.goto('http://127.0.0.1:4173/perfectPitch/')
    const root = variant === 'before' ? `/perfectPitch/${baseline}/src` : '/perfectPitch/src'
    const result = await page.evaluate(async ({ root, input, duration, label, soundfontText }) => {
      const { buildScore } = await import(`${root}/notation/score.ts`) as typeof import('../../src/notation/score.ts')
      const { scoreToPiano } = await import(`${root}/notation/score-playback.ts`) as typeof import('../../src/notation/score-playback.ts')
      const { scoreToMidi } = await import(`${root}/notation/midi.ts`) as typeof import('../../src/notation/midi.ts')
      const { renderMeasures } = await import(`${root}/ui/score-renderer.ts`) as typeof import('../../src/ui/score-renderer.ts')
      const playbackPath = '/perfectPitch/src/audio/playback-model.ts', voicePath = '/perfectPitch/src/audio/piano-voice.ts'
      const { parseSoundfont } = await import(playbackPath) as typeof import('../../src/audio/playback-model.ts')
      const { schedulePianoVoice } = await import(voicePath) as typeof import('../../src/audio/piano-voice.ts')
      const score = buildScore(input, duration, 120), piano = scoreToPiano(score)
      const host = document.querySelector<HTMLElement>('#score')!
      host.hidden = false
      host.innerHTML = '<h2></h2><p>120 BPM・4/4。合成の原音符を直接Scoreへ入力。</p><div class="score-measures"></div>'
      host.querySelector('h2')!.textContent = label
      const renderingStarted = performance.now()
      await renderMeasures(host.querySelector('.score-measures')!, score.measures, 0, { ppq: score.ppq ?? 4 })
      const renderMs = performance.now() - renderingStarted
      Object.assign(window, { artifactRender: () => renderMeasures(host.querySelector('.score-measures')!, score.measures, 0, { ppq: score.ppq ?? 4 }) })
      // 元製品と同じ音源・schedulePianoVoice。PCMは原音符の検出テストとは別の譜面演奏成果物。
      const bank = parseSoundfont(soundfontText)
      const rate = 48000, context = new OfflineAudioContext(1, Math.ceil((piano.duration + .15) * rate), rate)
      const starts: { midi: number; when: number; end: number }[] = []
      for (const note of piano.notes) {
        const name = ['C', 'Db', 'D', 'Eb', 'E', 'F', 'Gb', 'G', 'Ab', 'A', 'Bb', 'B'][note.midi % 12] + (Math.floor(note.midi / 12) - 1)
        const bytes = Uint8Array.from(atob(bank[name].split(',')[1]), c => c.charCodeAt(0))
        const sample = await context.decodeAudioData(bytes.buffer)
        schedulePianoVoice(context, { sample, sampleMidi: note.midi, note, startedAt: 0, offset: 0 })
        starts.push({ midi: note.midi, when: note.start, end: note.end })
      }
      const pcm = (await context.startRendering()).getChannelData(0)
      return { midi: Array.from(scoreToMidi(score)), score, piano, starts, renderMs,
        pcm: Array.from(pcm), rate, labels: Array.from(host.querySelectorAll('svg')).map(svg => svg.getAttribute('aria-label')) }
    }, { root, input: performanceNotes(fixture.notes), duration: fixture.duration, soundfontText: readFileSync('output/piano.js', 'utf8'), label: `${fixture.label} / ${variant === 'before' ? '修正前' : '修正後'}` })
    const parsed = parseMidi(new Uint8Array(result.midi))
    assert.deepEqual(parsed.events.filter(e => e.status === 0x90).map(e => e.data[0]), result.starts.map((n: { midi: number }) => n.midi))
    if (variant === 'after') assert.deepEqual(result.starts.map((n: { midi: number }) => n.midi), fixture.pitches)
    const wav = pcmWav(result.pcm, result.rate), midi = new Uint8Array(result.midi), prefix = `${fixture.id}-${variant}`
    assert.ok(result.pcm.some((sample: number) => Math.abs(sample) > .001))
    writeFileSync(`${destination}/${prefix}.wav`, wav)
    writeFileSync(`${destination}/${prefix}.mid`, midi)
    for (const width of [1280, 375]) {
      await page.setViewportSize({ width, height: 900 })
      await page.evaluate(async () => { await (window as unknown as { artifactRender(): Promise<void> }).artifactRender() })
      await page.locator('#score').screenshot({ path: `${destination}/${prefix}-${width}.png` })
    }
    const { pcm: _pcm, midi: _midi, ...metadata } = result
    records.push({ id: fixture.id, variant, ...metadata, wavSha256: hash(wav), midiSha256: hash(midi) })
    await page.close()
  }
} finally {
  await browser.close()
  await server.close()
}
writeFileSync(`${destination}/manifest.json`, JSON.stringify({ baselineSha: readFileSync(`${baseline}/sha.txt`, 'utf8').trim(),
  generatedAt: new Date().toISOString(), soundfontSha256: hash(readFileSync('output/piano.js')),
  sourceHashes: Object.fromEntries(['src/notation/score.ts', 'src/notation/score-playback.ts', 'src/notation/midi.ts',
    'src/ui/score-renderer.ts', 'src/audio/piano-voice.ts', 'src/audio/playback-model.ts', 'scripts/evaluation/score-artifacts.ts']
    .map(file => [file, hash(readFileSync(file))])),
  soundfontSource: 'https://gleitz.github.io/midi-js-soundfonts/FluidR3_GM/acoustic_grand_piano-mp3.js',
  audio: 'Same production piano samples and schedulePianoVoice rendered in OfflineAudioContext; synthetic note input, no microphone recording.', records }, null, 2))
writeFileSync(`${destination}/index.html`, `<!doctype html><html lang="ja"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>短音を保持するScore変換：比較材料</title>
<style>body{font:16px system-ui;margin:24px auto;padding:0 16px;max-width:1100px;background:#f5f7fa;color:#20334c}section{margin:32px 0}.pair{display:grid;grid-template-columns:repeat(auto-fit,minmax(280px,1fr));gap:16px}article{background:white;padding:16px;border-radius:8px}img{width:100%;height:auto}audio{width:100%}a{color:#075ca8}</style>
<h1>検出済みの音符を、楽譜化で消さない</h1><p>全例120 BPM・4/4。検出器を介さない同一の合成音符列を比較しています。音声は製品のピアノ音源と再生処理による書き出しです。元音声・物理マイクの評価ではありません。</p>
${scoreCases.map(f => `<section><h2>${f.label}</h2><div class="pair">${['before', 'after'].map(v => `<article><h3>${v === 'before' ? '修正前' : '修正後'}</h3><img alt="${f.label} ${v === 'before' ? '修正前' : '修正後'}の五線譜とカタカナ" src="${f.id}-${v}-1280.png"><audio controls preload="none" src="${f.id}-${v}.wav"></audio><p><a href="${f.id}-${v}.mid" download>MIDI</a> · <a href="${f.id}-${v}.wav" download>譜面ピアノWAV</a> · <a href="${f.id}-${v}-375.png">375px画像</a></p></article>`).join('')}</div></section>`).join('')}
<p>ピアノ: FluidR3_GM / Benjamin Gleitzman, CC BY 3.0 US。長音はタイで1打鍵として予約し、音源自体は自然減衰します。<a href="manifest.json">原入力・Score・再生予定・hash</a></p></html>`)
console.log(`比較素材を ${destination} へ保存しました`)
