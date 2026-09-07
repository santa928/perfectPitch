import { readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { createHash } from 'node:crypto'
import { analyzeOffline } from '../src/analysis/offline.ts'
import { extractMelody, suggestTempo } from '../src/analysis/melody.ts'
import { buildScore } from '../src/notation/score.ts'
import { scoreToPiano } from '../src/notation/score-playback.ts'
import { evaluateNotes, evaluateTempo, type ReferenceNote } from './score-evaluation.ts'

interface Reference {
  id: string; role: string; bpm: number; notes: ReferenceNote[]
  audioDuration: number; sampleRate: number; frames: number
}
interface Engine {
  analyzeOffline: typeof analyzeOffline; extractMelody: typeof extractMelody
  suggestTempo: typeof suggestTempo; buildScore: typeof buildScore
  scoreToPiano: typeof scoreToPiano
}

/** 本番解析にはPCMだけを渡す。公式譜面は解析後の評価と明示的なテンポ指定の診断だけに使う。 */
function evaluate(engine: Engine, reference: Reference, samples: Float32Array) {
  const started = performance.now()
  const frames = engine.analyzeOffline(samples, reference.sampleRate, 'song')
  const melody = engine.extractMelody(frames, reference.audioDuration)
  const tempo = engine.suggestTempo(melody)
  const usedBpm = tempo.reliable ? tempo.bpm : 120
  const score = engine.buildScore(melody, reference.audioDuration, usedBpm)
  const piano = engine.scoreToPiano(score)
  const elapsedMs = performance.now() - started
  // 別集計: UIで正解BPMを手動入力できた場合の上限診断。自動推定の実績に混ぜない。
  const manualScore = engine.buildScore(melody, reference.audioDuration, reference.bpm)
  const manualPiano = engine.scoreToPiano(manualScore)
  return {
    summary: {
      notes: melody.length, tempo, usedBpm, elapsedMs,
      melody: evaluateNotes(reference.notes, melody),
      score: evaluateNotes(reference.notes, piano.notes.map(n => ({
        ...n, start: n.start + score.origin, end: n.end + score.origin,
      }))),
      usedTempoError: evaluateTempo(reference.bpm, usedBpm),
      acceptedTempoError: tempo.reliable ? evaluateTempo(reference.bpm, tempo.bpm) : null,
      omitted: score.omittedNotes,
      manualReferenceTempo: {
        bpm: reference.bpm, omitted: manualScore.omittedNotes,
        score: evaluateNotes(reference.notes, manualPiano.notes.map(n => ({
          ...n, start: n.start + manualScore.origin, end: n.end + manualScore.origin,
        }))),
      },
    }, frames, melody, tempo, score, piano, manualScore,
  }
}

/** 固定3曲を評価する。未使用曲は明示オプションまで除外し、派生メディアはoutput内だけへ保存する。 */
async function main(): Promise<void> {
  const args = process.argv.slice(2)
  const includeHoldout = args.includes('--include-holdout')
  const position = args.indexOf('--baseline-src')
  if (position < 0 || !args[position + 1] || args.some((arg, index) =>
    index !== position + 1 && !['--include-holdout', '--baseline-src'].includes(arg)))
    throw new Error('Usage: --baseline-src output/pjs-evaluation/baseline/src [--include-holdout]')
  const source = resolve(args[position + 1])
  const moduleAt = (file: string) => import(pathToFileURL(resolve(source, file)).href)
  const [offline, melody, notation, playback] = await Promise.all([
    moduleAt('analysis/offline.ts'), moduleAt('analysis/melody.ts'),
    moduleAt('notation/score.ts'), moduleAt('notation/score-playback.ts'),
  ])
  const baseline: Engine = { ...offline, ...melody, ...notation, ...playback }
  const current: Engine = { analyzeOffline, extractMelody, suggestTempo, buildScore, scoreToPiano }
  const results = []
  for (const id of includeHoldout ? ['pjs010', 'pjs017', 'pjs040'] : ['pjs010', 'pjs040']) {
    const folder = `output/pjs-evaluation/${id}`
    const bytes = readFileSync(`${folder}/input.f32`)
    const referenceBytes = readFileSync(`${folder}/reference.json`)
    const reference: Reference = JSON.parse(referenceBytes.toString('utf8'))
    if (reference.id !== id || reference.sampleRate !== 48000 || reference.frames * 4 !== bytes.length
      || reference.audioDuration <= 0 || reference.audioDuration > 60
      || Math.abs(reference.frames / reference.sampleRate - reference.audioDuration) > 1e-6)
      throw new Error(`Invalid input metadata: ${id}`)
    const samples = new Float32Array(reference.frames)
    for (let i = 0; i < samples.length; i++) {
      samples[i] = bytes.readFloatLE(i * 4)
      if (!Number.isFinite(samples[i]) || Math.abs(samples[i]) > 1) throw new Error(`Invalid PCM: ${id}`)
    }
    const before = evaluate(baseline, reference, samples)
    const after = evaluate(current, reference, samples)
    writeFileSync(`${folder}/before.json`, JSON.stringify(before, null, 2) + '\n')
    writeFileSync(`${folder}/after.json`, JSON.stringify(after, null, 2) + '\n')
    const result = {
      id, role: reference.role, referenceBpm: reference.bpm, referenceNotes: reference.notes.length,
      inputSha256: createHash('sha256').update(bytes).digest('hex'),
      referenceSha256: createHash('sha256').update(referenceBytes).digest('hex'),
      before: before.summary, after: after.summary,
    }
    results.push(result)
    console.log(JSON.stringify({ id, referenceBpm: reference.bpm,
      beforeF1: before.summary.score.onset.f1, afterF1: after.summary.score.onset.f1,
      afterBpm: after.summary.usedBpm, tempoReliable: after.tempo.reliable }))
  }
  writeFileSync('output/pjs-evaluation/comparison.json', JSON.stringify({
    mode: 'song', alignment: 'source clock, no shift or transposition',
    includeHoldout, baselineSource: args[position + 1], results,
  }, null, 2) + '\n')
}

await main()
