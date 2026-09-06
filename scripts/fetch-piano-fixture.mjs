import { mkdirSync, writeFileSync } from 'node:fs'
// CC BY 3.0, same source as runtime; downloaded audio never enters git.
const url =
  'https://gleitz.github.io/midi-js-soundfonts/FluidR3_GM/acoustic_grand_piano-mp3.js'
const response = await fetch(url)
if (!response.ok) throw new Error(`Soundfont fetch: ${response.status}`)
mkdirSync('output', { recursive: true })
writeFileSync('output/piano.js', await response.text())
