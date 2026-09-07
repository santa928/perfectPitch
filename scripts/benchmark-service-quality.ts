/** 公的音声だけを実ブラウザの本番APIで解析し、正解はNode側の採点にのみ使う。 */
import { readFileSync, writeFileSync, mkdirSync, existsSync, realpathSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { resolve, relative, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'
import { chromium } from '@playwright/test'
import { createServer } from 'vite'
import { evaluateNotes, evaluateTempo, type ReferenceNote } from './score-evaluation.ts'
import type { PitchFrame } from '../src/analysis/pipeline.ts'
import type { PianoNote } from '../src/analysis/notes.ts'

const project = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const development = [1, 2, 17]
const final = [4, 24, 35, 37]
type F0Point = { t: number; hz: number }
type Clip = { id: string; split: string; directory: string; officialBpm: number | null }

/** 入力のハッシュを残す。音声データ・絶対パスは公開結果へ入れない。 */
function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex')
}

/** 人手F0のnative clockで25ms以内の最近傍。無声区間を補間・移調しない。 */
function evaluateF0(frames: PitchFrame[], reference: F0Point[]) {
  let index = 0, tp = 0, fp = 0, fn = 0, tn = 0, raw50 = 0, chroma50 = 0, strict50 = 0, strictChroma50 = 0
  const centsValues: number[] = []
  for (const target of reference) {
    while (index + 1 < frames.length && Math.abs(frames[index + 1].t - target.t) < Math.abs(frames[index].t - target.t)) index++
    const found = frames[index]
    const frame = found && Math.abs(found.t - target.t) <= .025 ? found : undefined
    const predicted = frame?.state === 'voiced' && (frame.frequency ?? 0) > 0
    const truth = target.hz > 0
    if (predicted && truth) tp++
    else if (predicted) fp++
    else if (truth) fn++
    else tn++
    if (!truth || !(frame?.frequency && frame.frequency > 0)) continue
    const cents = 1200 * Math.log2(frame.frequency / target.hz)
    if (Math.abs(cents) <= 50) { raw50++; if (predicted) strict50++ }
    if (Math.abs(cents - 1200 * Math.round(cents / 1200)) <= 50) { chroma50++; if (predicted) strictChroma50++ }
    if (predicted) centsValues.push(cents)
  }
  const absolute = centsValues.map(Math.abs).sort((a, b) => a - b)
  const signed = [...centsValues].sort((a, b) => a - b)
  const voiced = tp + fn
  return { samples: reference.length, gtVoiced: voiced, tp, fp, fn, tn,
    voicedPrecision: tp + fp ? tp / (tp + fp) : 0, voicedRecall: voiced ? tp / voiced : 0,
    rawPitchAccuracy50: voiced ? raw50 / voiced : 0, rawChromaAccuracy50: voiced ? chroma50 / voiced : 0,
    acceptedPitchAccuracy50: voiced ? strict50 / voiced : 0, acceptedChromaAccuracy50: voiced ? strictChroma50 / voiced : 0,
    raw50, chroma50, strict50, strictChroma50, bothVoicedCount: absolute.length,
    bothVoicedCents: { medianAbsolute: absolute[Math.floor(absolute.length / 2)] ?? null,
      meanAbsolute: absolute.length ? absolute.reduce((a, b) => a + b, 0) / absolute.length : null,
      p90Absolute: absolute[Math.min(absolute.length - 1, Math.floor(absolute.length * .9))] ?? null,
      medianSigned: signed[Math.floor(signed.length / 2)] ?? null } }
}

/** 音符が人手有声/無声時点に重なる割合。F0精度とは呼ばない。 */
function noteCoverage(notes: ReferenceNote[], reference: F0Point[]) {
  let voiced = 0, unvoiced = 0, coveredVoiced = 0, coveredUnvoiced = 0
  for (const { t, hz } of reference) {
    const covered = notes.some(note => note.start <= t && t < note.end)
    if (hz > 0) { voiced++; if (covered) coveredVoiced++ }
    else { unvoiced++; if (covered) coveredUnvoiced++ }
  }
  return { voicedFrames: voiced, unvoicedFrames: unvoiced,
    voicedCoverage: voiced ? coveredVoiced / voiced : null,
    unvoicedCoverage: unvoiced ? coveredUnvoiced / unvoiced : null }
}

/** output/ 外への保存や既存結果の上書きを拒否する。 */
function checkedOutput(path: string): string {
  const target = resolve(project, path), root = resolve(project, 'output')
  if (!relative(root, target) || relative(root, target).startsWith('..')) throw new Error('--output must be below output/')
  if (existsSync(target)) throw new Error('Output already exists; choose another --output')
  let parent = dirname(target)
  while (!existsSync(parent)) parent = dirname(parent)
  if (relative(realpathSync(root), realpathSync(parent)).startsWith('..')) throw new Error('Output symlink leaves output/')
  return target
}

/** Vite・ブラウザを起動し、録音権限なしで原音→本番Worker→楽譜の結果だけを採点する。 */
async function main(): Promise<void> {
  const { values } = parseArgs({ options: {
    'include-final': { type: 'boolean' }, 'include-pjs': { type: 'boolean' },
    output: { type: 'string' }, only: { type: 'string' }, help: { type: 'boolean' },
  } })
  if (values.help) {
    console.log('Docker: node --experimental-strip-types scripts/benchmark-service-quality.ts [--include-final] [--include-pjs] [--only vocadito_1] [--output output/service-quality/browser-NEW.json]')
    return
  }
  const output = checkedOutput(values.output ?? `output/service-quality/browser-${Date.now()}.json`)
  let clips: Clip[] = [...development, ...(values['include-final'] ? final : [])].map(number => ({
    id: `vocadito_${number}`, split: development.includes(number) ? 'development' : 'final-regression',
    directory: `output/service-quality/vocadito/vocadito_${number}`, officialBpm: null,
  }))
  if (values['include-pjs']) clips.push(...(['pjs010', 'pjs017', 'pjs040'] as const).map(id => ({
    id, split: id === 'pjs017' ? 'previously-used-regression' : 'development',
    directory: `output/pjs-evaluation/${id}`, officialBpm: { pjs010: 80, pjs017: 120, pjs040: 180 }[id],
  })))
  if (values.only) clips = clips.filter(clip => clip.id === values.only)
  if (!clips.length) throw new Error('No selected public clip; final requires --include-final')
  for (const clip of clips) if (!existsSync(resolve(project, clip.directory, 'input.wav')))
    throw new Error(`Missing ${clip.id}; run the corpus fetch script first`)
  const sourceFiles = ['src/analysis/pipeline.ts', 'src/analysis/offline.ts', 'src/analysis/detectors.ts',
    'src/analysis/melody.ts', 'src/analysis/model-notes.ts', 'src/audio/capture.ts', 'src/audio/analysis-worker.ts',
    'src/audio/transcription.ts', 'src/audio/transcription-worker.ts', 'src/notation/score.ts',
    'src/notation/score-playback.ts', 'scripts/score-evaluation.ts', 'scripts/benchmark-service-quality.ts',
    'scripts/copy-transcription-assets.mjs', 'package-lock.json']
  const sourceHashes = Object.fromEntries(sourceFiles.map(path => [path, sha256(readFileSync(resolve(project, path)))]))
  const assets = ['public/models/basic-pitch.onnx', 'public/runtime/ort-wasm-simd-threaded.wasm',
    'public/runtime/ort-wasm-simd-threaded.mjs', 'public/runtime/ort.wasm.min.mjs'].map(path => {
    if (!existsSync(resolve(project, path))) return { path, bytes: null, sha256: null }
    const bytes = readFileSync(resolve(project, path))
    return { path, bytes: bytes.length, sha256: sha256(bytes) }
  })
  const server = await createServer({ root: project, server: { host: '127.0.0.1', port: 0, open: false } })
  await server.listen()
  const address = server.httpServer!.address()
  if (!address || typeof address === 'string') throw new Error('Vite address unavailable')
  const origin = `http://127.0.0.1:${address.port}`, base = server.config.base
  const browser = await chromium.launch({ headless: true }).catch(async (error: unknown) => {
    await server.close()
    throw error
  })
  const rows: unknown[] = []
  try {
    const page = await browser.newPage()
    page.setDefaultTimeout(180_000)
    // All model/runtime/source requests must remain on this local origin.
    await page.route('**/*', route => new URL(route.request().url()).origin === origin ? route.continue() : route.abort())
    await page.goto(`${origin}${base}`)
    for (const clip of clips) {
      const audio = readFileSync(resolve(project, clip.directory, 'input.wav'))
      const audioUrl = `${origin}${base}__evaluation_audio__.wav`
      await page.route(audioUrl, route => route.fulfill({ body: audio, contentType: 'audio/wav' }))
      console.log(`Analyzing ${clip.id} (public audio only)`)
      // Only audio URL and the explicitly manual score BPM cross into the browser; no reference notes/F0.
      const result = await page.evaluate(async ({ audioUrl, base, officialBpm }) => {
        const capture = await import(`${base}src/audio/capture.ts`) as {
          reanalyze(samples: Float32Array, rate: number, mode: 'song', progress: undefined, options: { calibrate: boolean }): Promise<PitchFrame[]>
        }
        const melody = await import(`${base}src/analysis/melody.ts`) as typeof import('../src/analysis/melody.ts')
        const transcription = await import(`${base}src/audio/transcription.ts`) as {
          transcribeMelody(samples: Float32Array, rate: number, options: {
            onProgress(event: { stage: string; progress?: number }): void
          }): Promise<PianoNote[]>
        }
        const notation = await import(`${base}src/notation/score.ts`) as typeof import('../src/notation/score.ts')
        const playback = await import(`${base}src/notation/score-playback.ts`) as typeof import('../src/notation/score-playback.ts')
        const context = new OfflineAudioContext(1, 1, 48000)
        const decodeStart = performance.now()
        const decoded = await context.decodeAudioData(await (await fetch(audioUrl)).arrayBuffer())
        const samples = new Float32Array(decoded.length)
        for (let channel = 0; channel < decoded.numberOfChannels; channel++) {
          const data = decoded.getChannelData(channel)
          for (let i = 0; i < samples.length; i++) samples[i] += data[i] / decoded.numberOfChannels
        }
        const decodeSeconds = (performance.now() - decodeStart) / 1000, duration = samples.length / decoded.sampleRate
        const yinStart = performance.now()
        const frames = await capture.reanalyze(samples, decoded.sampleRate, 'song', undefined, { calibrate: false })
        const yinNotes = melody.extractMelody(frames, duration)
        const yinSeconds = (performance.now() - yinStart) / 1000, modelStart = performance.now()
        const progress: { stage: string; elapsedSeconds: number; progress?: number }[] = []
        const modelNotes = await transcription.transcribeMelody(samples, decoded.sampleRate, { onProgress: event => {
          if (event.stage !== progress.at(-1)?.stage) progress.push({ ...event, elapsedSeconds: (performance.now() - modelStart) / 1000 })
        } })
        const modelSeconds = (performance.now() - modelStart) / 1000
        /** 通常提案・手動120・公式BPMの条件を分離し、採点時だけoriginを戻す。 */
        const delivery = (notes: PianoNote[]) => {
          const suggestion = melody.suggestTempo(notes)
          const conditions = [{ name: 'manual120', bpm: 120 },
            { name: 'automatic', bpm: suggestion.reliable ? suggestion.bpm : 120 },
            ...(officialBpm === null ? [] : [{ name: 'manualOfficial', bpm: officialBpm }])]
          return { notes, suggestion, scores: conditions.map(({ name, bpm }) => {
            const score = notation.buildScore(notes, duration, bpm)
            return { condition: name, usedBpm: bpm, usedFallback: name === 'automatic' && !suggestion.reliable,
              omittedNotes: score.omittedNotes, origin: score.origin,
              notes: playback.scoreToPiano(score).notes.map(note => ({ start: note.start + score.origin, end: note.end + score.origin, midi: note.midi })) }
          }) }
        }
        return { sampleRate: decoded.sampleRate, duration, decodeSeconds, crossOriginIsolated,
          userAgent: navigator.userAgent, hardwareConcurrency: navigator.hardwareConcurrency,
          yin: { ...delivery(yinNotes), frames, totalSeconds: yinSeconds },
          model: { ...delivery(modelNotes), totalSeconds: modelSeconds, progress } }
      }, { audioUrl, base, officialBpm: clip.officialBpm })
      await page.unroute(audioUrl)
      const annotations = clip.id.startsWith('vocadito') ? ['A1', 'A2'] : ['official']
      const references = annotations.map(annotation => {
        const file = annotation === 'official' ? 'reference.json' : `reference${annotation}.json`
        const bytes = readFileSync(resolve(project, clip.directory, file))
        const parsed = JSON.parse(bytes.toString()) as ReferenceNote[] | { notes: ReferenceNote[] }
        return { annotation, sha256: sha256(bytes), notes: Array.isArray(parsed) ? parsed : parsed.notes }
      })
      const f0Bytes = clip.id.startsWith('vocadito') ? readFileSync(resolve(project, clip.directory, 'f0.csv')) : null
      const f0: F0Point[] = f0Bytes ? f0Bytes.toString().trim().split(/\r?\n/).map(line => {
        const [t, hz] = line.split(',').map(Number)
        if (!Number.isFinite(t) || !Number.isFinite(hz) || t < 0 || hz < 0) throw new Error('Invalid F0 annotation')
        return { t, hz }
      }) : []
      const methods = Object.fromEntries((['yin', 'model'] as const).map(method => {
        const data = result[method]
        return [method, { totalSeconds: data.totalSeconds, estimatedNotes: data.notes.length,
          metrics: references.map(ref => ({ annotation: ref.annotation, ...evaluateNotes(ref.notes, data.notes) })),
          suggestion: data.suggestion,
          automaticTempoError: clip.officialBpm !== null && data.suggestion.reliable ? evaluateTempo(clip.officialBpm, data.suggestion.bpm) : null,
          scores: data.scores.map(score => ({ condition: score.condition, usedBpm: score.usedBpm,
            usedFallback: score.usedFallback, omittedNotes: score.omittedNotes, estimatedNotes: score.notes.length,
            metrics: references.map(ref => ({ annotation: ref.annotation, ...evaluateNotes(ref.notes, score.notes) })),
            usedBpmError: clip.officialBpm === null ? null : evaluateTempo(clip.officialBpm, score.usedBpm) })),
          f0: method === 'yin' && f0.length ? evaluateF0(result.yin.frames, f0) : null,
          f0NotApplicable: method === 'model' ? 'Note activity decoder; not an F0 estimator' : null,
          noteCoverage: f0.length ? noteCoverage(data.notes, f0) : null }]
      }))
      rows.push({ id: clip.id, split: clip.split, audioSha256: sha256(audio), duration: result.duration,
        sampleRate: result.sampleRate, officialBpm: clip.officialBpm, decodeSeconds: result.decodeSeconds,
        browser: { userAgent: result.userAgent, crossOriginIsolated: result.crossOriginIsolated, hardwareConcurrency: result.hardwareConcurrency },
        referenceHashes: references.map(({ annotation, sha256 }) => ({ annotation, sha256 })),
        f0Sha256: f0Bytes ? sha256(f0Bytes) : null, methods, modelProgress: result.model.progress,
        referenceCoverage: f0.length ? references.map(ref => ({ annotation: ref.annotation, ...noteCoverage(ref.notes, f0) })) : null })
    }
    for (const [path, before] of Object.entries(sourceHashes))
      if (sha256(readFileSync(resolve(project, path))) !== before) throw new Error(`Source changed during evaluation: ${path}`)
    mkdirSync(dirname(output), { recursive: true })
    writeFileSync(output, JSON.stringify({ schema: 1, createdAt: new Date().toISOString(), sourceHashes, assets,
      conditions: { backend: 'production-browser-worker', modelWasmThreads: 1, yinCalibrate: false, inputSampleRate: 48000,
        modelRpaApplicable: false, rawModelActivityAvailable: false, includeFinal: !!values['include-final'],
        timing: 'One cold worker call per clip; total includes model load, browser resampling and DP. Decode time separate. No mobile performance claim.',
        repeatFinal: 'These IDs were already unsealed for the frozen pilot; repeat runs are regression, not new holdout.',
        noteMatching: 'Exact integer MIDI; onset <=100ms; offset <=max(100ms,20% reference duration); maximum one-to-one matching; no alignment/transpose.',
        tempo: 'Unreliable suggestion falls back to120; usedBpmError does not imply automatic success; vocadito official BPM unknown.' }, rows }, null, 2) + '\n', { flag: 'wx' })
    console.log(`Saved ${relative(project, output)} (${rows.length} public clips)`)
  } finally {
    await browser.close()
    await server.close()
  }
}

await main()
