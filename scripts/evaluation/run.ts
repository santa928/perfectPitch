/** 本番モジュールをDockerブラウザで実行する。正解・splitはNode側だけに保持する。 */
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { resolve } from 'node:path'
import { parseArgs } from 'node:util'
import { chromium } from '@playwright/test'
import { createServer } from 'vite'
import { evaluateF0, evaluateNoteEvents, noteDiagnostics, scoreDiagnostics, validateSplit, type F0, type Note, type GroupedClip } from './metrics.ts'
import { syntheticCorpus, floatWav } from './synthetic.ts'
import type { PitchFrame } from '../../src/analysis/pipeline.ts'
import { sourceFingerprint, readReference, readManifest, validateHoldoutSeal } from './contract.ts'

interface Clip extends GroupedClip { duration: number; sha256: Record<string, string>; kind: string }
const root = process.cwd()
/** 再現対象ファイルを固定hashで記録する。 */
function sha(bytes: Uint8Array | string): string { return createHash('sha256').update(bytes).digest('hex') }

/** 固定splitだけを逐次実行し、各音源終了時にcheckpointする。 */
async function main(): Promise<void> {
  const { values } = parseArgs({ options: { split: { type: 'string', default: 'development' },
    output: { type: 'string' }, only: { type: 'string' }, seal: { type: 'string' }, freeze: { type: 'boolean' },
    'yin-rate': { type: 'string', default: '48000' }, 'skip-model': { type: 'boolean' } } })
  const manifestBytes = readFileSync('docs/evaluation/humming-manifest-v1.json')
  const manifest = readManifest()
  validateSplit(manifest.tracks)
  if (!['development', 'validation', 'final-holdout', 'synthetic'].includes(values.split!)) throw new Error('invalid split')
  const output = resolve(values.output ?? `output/issue21/${values.split}-${Date.now()}`)
  if (!output.startsWith(resolve('output/issue21') + '/') || existsSync(output)) throw new Error('Choose a new output/issue21 child directory')
  const sourceHashes = sourceFingerprint()
  const yinRate = Number(values['yin-rate'])
  if (![16000, 22050, 48000].includes(yinRate)) throw new Error('unsupported evaluation rate')
  const configuration = { yinRate, mode: 'song', calibrate: false, scoreBpm: 120, model: !values['skip-model'] }
  if (values.split === 'final-holdout' && !values.freeze) {
    if (values.only) throw new Error('final holdout cannot be reduced with --only')
    if (!values.seal) throw new Error('holdout requires --seal with previously frozen source/configuration')
  }
  mkdirSync(output, { recursive: true })
  const synthetic = values.split === 'synthetic' ? syntheticCorpus() : []
  const clips: Clip[] = values.split === 'synthetic' ? synthetic.map(c => ({ id: c.id, split: 'development-regression',
    speakerGroup: c.id, melodyGroup: c.id, sourceGroup: c.id, kind: 'synthetic', duration: c.samples.length / c.sampleRate,
    sha256: { 'input.wav': sha(floatWav(c.samples, c.sampleRate)) } })) : manifest.tracks.filter(c => c.split === values.split)
  const selected = values.only ? clips.filter(c => c.id === values.only) : clips
  if (!selected.length) throw new Error('no selected clips')
  const server = await createServer({ root, server: { host: '127.0.0.1', port: 0, open: false } })
  await server.listen()
  const address = server.httpServer!.address()
  if (!address || typeof address === 'string') throw new Error('server address unavailable')
  const origin = `http://127.0.0.1:${address.port}`, base = server.config.base
  const browser = await chromium.launch({ headless: true })
  const environment = { node: process.version, platform: process.platform, arch: process.arch, browser: browser.version(),
    playwright: JSON.parse(readFileSync('node_modules/@playwright/test/package.json', 'utf8')).version,
    vite: JSON.parse(readFileSync('node_modules/vite/package.json', 'utf8')).version }
  if (values.freeze) {
    writeFileSync(`${output}/seal.json`, JSON.stringify({ kind: 'issue21-holdout-freeze-v1', sourceHashes, configuration, environment, manifestSha256: sha(manifestBytes), frozenAt: new Date().toISOString() }, null, 2))
    await browser.close(); await server.close()
    console.log(`Frozen source/configuration/environment without reading audio or labels: ${output}/seal.json`)
    return
  }
  if (values.split === 'final-holdout') {
    try { validateHoldoutSeal(JSON.parse(readFileSync(values.seal!, 'utf8')), { sourceHashes, configuration, environment, manifestSha256: sha(manifestBytes) }) }
    catch (error) { await browser.close(); await server.close(); throw error }
  }
  const rows: unknown[] = []
  const report = { baselineSha: manifest.baselineSha, sourceSha: execFileSync('git', ['rev-parse', 'HEAD']).toString().trim(),
    sourceHashes, manifestSha256: sha(manifestBytes), configuration, split: values.split, expectedIds: selected.map(c => c.id), complete: false,
    environment, holdoutSealSha256: values.split === 'final-holdout' ? sha(readFileSync(values.seal!)) : null,
    assets: ['public/models/basic-pitch.onnx', 'public/runtime/ort-wasm-simd-threaded.wasm'].map(file =>
      ({ file, bytes: readFileSync(file).length, sha256: sha(readFileSync(file)) })), rows }
  writeFileSync(`${output}/seal.json`, JSON.stringify({ sourceHashes, configuration, environment, manifestSha256: sha(manifestBytes) }, null, 2))
  try {
    const page = await browser.newPage()
    const blockedRequests: string[] = [], pageErrors: string[] = []
    page.on('pageerror', error => pageErrors.push(error.message))
    await page.route('**/*', route => {
      const request = new URL(route.request().url())
      const path = decodeURIComponent(request.pathname).slice(base.length)
      const allowed = path === '' || path === 'index.html' || path === '__issue21_audio.wav' || path === 'node_modules/vite/dist/client/env.mjs' ||
        ['src/', 'node_modules/.vite/', '@vite/', 'models/', 'runtime/'].some(prefix => path.startsWith(prefix))
      if (request.origin === origin && request.pathname.startsWith(base) && allowed) return route.continue()
      blockedRequests.push(request.pathname)
      console.error(`Blocked evaluation request: ${request.pathname}`)
      return route.abort()
    })
    await page.route(`${origin}${base}`, route => route.fulfill({ contentType: 'text/html',
      body: '<!doctype html><meta charset="utf-8"><title>採譜評価</title>' }))
    await page.goto(`${origin}${base}`)
    const denied = await page.evaluate(async paths => Promise.all(paths.map(async path => {
      try { await fetch(path); return false } catch { return true }
    })), [`${base}output/issue21/corpus/vocadito_1/notesA1.csv`, `${base}docs/evaluation/humming-manifest-v1.json`, `${base}@fs/app/output/issue21/corpus/vocadito_1/f0.csv`])
    if (!denied.every(Boolean)) throw new Error('Reference access isolation failed')
    blockedRequests.length = 0
    for (const clip of selected) {
      const generated = synthetic.find(c => c.id === clip.id)
      const folder = `output/issue21/corpus/${clip.id}`
      const audio = generated ? floatWav(generated.samples, generated.sampleRate) : readFileSync(`${folder}/input.wav`)
      if (sha(audio) !== clip.sha256['input.wav']) throw new Error(`audio hash mismatch ${clip.id}`)
      const audioUrl = `${origin}${base}__issue21_audio.wav`
      await page.route(audioUrl, route => route.fulfill({ body: Buffer.from(audio), contentType: 'audio/wav' }))
      console.log(`Analyzing ${clip.id}; ${clip.split}`)
      const result = await page.evaluate(async ({ audioUrl, base, yinRate, withModel }) => {
        const pipeline = await import(`${base}src/analysis/pipeline.ts`) as typeof import('../../src/analysis/pipeline.ts')
        const offline = await import(`${base}src/analysis/offline.ts`) as typeof import('../../src/analysis/offline.ts')
        const continuity = await import(`${base}src/analysis/continuity.ts`) as typeof import('../../src/analysis/continuity.ts')
        const melody = await import(`${base}src/analysis/melody.ts`) as typeof import('../../src/analysis/melody.ts')
        const notesModule = await import(`${base}src/analysis/notes.ts`) as typeof import('../../src/analysis/notes.ts')
        const transcription = await import(`${base}src/audio/transcription.ts`) as {
          transcribeMelody(samples: Float32Array, rate: number): Promise<import('../../src/analysis/notes.ts').PianoNote[]> }
        const notation = await import(`${base}src/notation/score.ts`) as typeof import('../../src/notation/score.ts')
        const playback = await import(`${base}src/notation/score-playback.ts`) as typeof import('../../src/notation/score-playback.ts')
        const began = performance.now()
        const decoded = await new OfflineAudioContext(1, 1, 48000).decodeAudioData(await (await fetch(audioUrl)).arrayBuffer())
        const original = new Float32Array(decoded.getChannelData(0)), duration = original.length / 48000
        const decodeMs = performance.now() - began
        let samples = original
        const resampleStart = performance.now()
        if (yinRate !== 48000) {
          const context = new OfflineAudioContext(1, Math.ceil(duration * yinRate), yinRate)
          const source = context.createBufferSource(); source.buffer = decoded; source.connect(context.destination); source.start()
          samples = new Float32Array((await context.startRendering()).getChannelData(0))
        }
        const resampleMs = performance.now() - resampleStart
        const liveStart = performance.now()
        const candidates: { t: number; candidates: { frequency: number; error: number }[] }[] = []
        const analyzer = new pipeline.PitchAnalyzer(yinRate, 'song', (frame, choices) => candidates.push({ t: frame.t, candidates: choices }), false)
        const live = [...analyzer.push(samples), ...analyzer.finish()]
        const liveMs = performance.now() - liveStart, offlineStart = performance.now()
        const reviewed = offline.analyzeOffline(samples, yinRate, 'song', undefined, false)
        const offlineMs = performance.now() - offlineStart, stable = continuity.stabilizePitchFrames(reviewed)
        const delivery = (notes: import('../../src/analysis/notes.ts').PianoNote[]) => {
          const score = notation.buildScore(notes, duration, 120)
          return { notes, score, scoreNotes: playback.scoreToPiano(score).notes.map(n => ({ ...n, start: n.start + score.origin, end: n.end + score.origin })) }
        }
        const noteStart = performance.now()
        const stages = { liveMelody: delivery(melody.extractMelody(live, duration)),
          rounded: delivery(notesModule.buildNotes(reviewed, 'song', 'rounded', duration)),
          yin: delivery(melody.extractMelody(reviewed, duration)) }
        const notesMs = performance.now() - noteStart
        const modelStart = performance.now()
        const model = withModel ? delivery(await transcription.transcribeMelody(original, 48000)) : null
        const modelMs = withModel ? performance.now() - modelStart : null
        return { duration, decodedSamples: original.length, decodedRate: 48000, analysisSamples: samples.length, analysisRate: yinRate,
          timing: { decodeMs, resampleMs, liveMs, offlineMs, notesMs, modelMs },
          live, reviewed, stable, candidates, stages, model }
      }, { audioUrl, base, yinRate, withModel: !values['skip-model'] })
      await page.unroute(audioUrl)
      const references: Record<string, Note[]> = generated ? { synthetic: generated.reference } :
        Object.fromEntries(['A1', 'A2'].map(a => {
          if (sha(readFileSync(`${folder}/notes${a}.csv`)) !== clip.sha256[`notes${a}.csv`]) throw new Error('reference hash mismatch')
          const ref = readReference(manifest.tracks.find(c => c.id === clip.id)!, a as 'A1' | 'A2')
          return [a, ref]
        }))
      const f0: F0[] = generated ? generated.f0 : readFileSync(`${folder}/f0.csv`, 'utf8').trim().split(/\r?\n/).map(line => {
        const [t, hz] = line.split(',').map(Number); return { t, hz }
      })
      if (!generated && sha(readFileSync(`${folder}/f0.csv`)) !== clip.sha256['f0.csv']) throw new Error('F0 hash mismatch')
      const toF0 = (frames: PitchFrame[]): F0[] => frames.map(f => ({ t: f.t, hz: f.frequency }))
      const f0Stages = { rawCandidate: evaluateF0(f0, result.live.map(f => ({ t: f.t, hz: f.initialGate?.candidateHz ?? null })), .01),
        live: evaluateF0(f0, toF0(result.live), .01), offline: evaluateF0(f0, toF0(result.reviewed), .01),
        continuity: evaluateF0(f0, toF0(result.stable), .01) }
      const noteStages = Object.fromEntries(Object.entries({ ...result.stages, ...(result.model ? { basicPitch: result.model } : {}) }).map(([method, data]) => [method, {
        annotations: Object.fromEntries(Object.entries(references).map(([a, ref]) => [a, {
          performance: evaluateNoteEvents(ref, data.notes), score: evaluateNoteEvents(ref, data.scoreNotes),
          performanceDiagnostics: noteDiagnostics(ref, data.notes, result.duration),
          scoreReferenceDiagnostics: noteDiagnostics(ref, data.scoreNotes, result.duration) }])),
        quantization: { ...scoreDiagnostics(data.notes, data.scoreNotes, result.duration), omittedNotes: data.score.omittedNotes,
          tieIn: data.score.measures.flat().filter(n => n.tieIn).length, tieOut: data.score.measures.flat().filter(n => n.tieOut).length },
        // 半音化した音符の占有proxyでありBasic PitchのネイティブF0とは呼ばない。
        noteDerivedF0Proxy: evaluateF0(f0, f0.map(f => ({ t: f.t,
          hz: (() => { const n = data.notes.find(n => n.start <= f.t && f.t < n.end); return n ? 440 * 2 ** ((n.midi - 69) / 12) : 0 })() })), .01),
        count: data.notes.length, scoreCount: data.scoreNotes.length }]))
      const row = { id: clip.id, split: clip.split, speakerGroup: clip.speakerGroup, kind: clip.kind, categories: generated?.categories ?? [],
        audioSha256: sha(audio), duration: result.duration, timing: result.timing, f0: f0Stages, notes: noteStages,
        annotationAgreement: references.A1 ? evaluateNoteEvents(references.A1, references.A2) : null }
      writeFileSync(`${output}/${clip.id}.stages.json`, JSON.stringify(result))
      writeFileSync(`${output}/${clip.id}.metrics.json`, JSON.stringify(row, null, 2))
      rows.push(row)
      writeFileSync(`${output}/results.json`, JSON.stringify({ ...report, blockedRequests, pageErrors }, null, 2))
      console.log(JSON.stringify({ id: clip.id, yinAccuracy50: f0Stages.offline.accuracy50, timing: result.timing }))
    }
    if (pageErrors.length || blockedRequests.length) throw new Error('browser errors or external requests observed')
    report.complete = true
    writeFileSync(`${output}/results.json`, JSON.stringify({ ...report, blockedRequests, pageErrors }, null, 2))
  } finally { await browser.close(); await server.close() }
}
await main()
