/** Python候補にも本番ブラウザと同じ48kHz decode PCMを渡す。正解は読み込まない。 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { chromium } from '@playwright/test'
import { syntheticCorpus, floatWav } from './synthetic.ts'
import { readManifest, hash } from './contract.ts'

const split = process.argv[2] ?? 'development'
if (!['development', 'validation', 'synthetic'].includes(split)) throw new Error('Exploratory PCM export cannot access holdout')
const manifest = readManifest()
const generated = split === 'synthetic' ? syntheticCorpus() : []
const ids = split === 'synthetic' ? generated.map(c => c.id) : manifest.tracks.filter(c => c.split === split).map(c => c.id)
const browser = await chromium.launch()
try {
  const page = await browser.newPage()
  const records = []
  for (const id of ids) {
    const fixture = generated.find(c => c.id === id)
    const folder = `output/issue21/corpus/${id}`
    mkdirSync(folder, { recursive: true })
    const wav = fixture ? floatWav(fixture.samples, fixture.sampleRate) : readFileSync(`${folder}/input.wav`)
    if (!fixture && hash(wav) !== manifest.tracks.find(c => c.id === id)!.sha256['input.wav']) throw new Error('Audio hash mismatch')
    if (fixture) {
      writeFileSync(`${folder}/input.wav`, wav)
      writeFileSync(`${folder}/referenceSynthetic.json`, JSON.stringify(fixture.reference))
      writeFileSync(`${folder}/f0.csv`, fixture.f0.map(f => `${f.t},${f.hz}`).join('\n'))
    }
    const encoded = await page.evaluate(async data => {
      const bytes = Uint8Array.from(atob(data), c => c.charCodeAt(0))
      const audio = await new OfflineAudioContext(1, 1, 48000).decodeAudioData(bytes.buffer)
      const pcm = new Uint8Array(audio.getChannelData(0).buffer)
      let binary = ''
      for (let i = 0; i < pcm.length; i += 16384) binary += String.fromCharCode(...pcm.subarray(i, i + 16384))
      return btoa(binary)
    }, Buffer.from(wav).toString('base64'))
    const pcm = Buffer.from(encoded, 'base64')
    writeFileSync(`${folder}/input48.f32`, pcm)
    records.push({ id, split, path: `${folder}/input48.f32`, sampleRate: 48000, samples: pcm.length / 4,
      sha256: createHash('sha256').update(pcm).digest('hex') })
  }
  writeFileSync(`output/issue21/pcm-${split}.json`, JSON.stringify({ browser: browser.version(), records }, null, 2))
  console.log(`Exported ${records.length} decoded inputs`)
} finally { await browser.close() }
