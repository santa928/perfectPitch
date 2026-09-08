/** #24の保存済み音符を同一入力として比較する。旧raw/sealと推論出力は書き換えない。 */
import assert from 'node:assert/strict'
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { buildScore, scorePpq, type Score } from '../../src/notation/score.ts'
import { scoreToLogicalNotes, scoreToPiano } from '../../src/notation/score-playback.ts'
import { scoreToMidi } from '../../src/notation/midi.ts'
import type { PianoNote } from '../../src/analysis/notes.ts'
import { evaluateNoteEvents, scoreDiagnostics } from './metrics.ts'
import { hash, readManifest, readReference, validateCompletion } from './contract.ts'
import { parseMidi } from '../../tests/helpers/parse-midi.ts'

type Stage = { notes: PianoNote[]; score: Score; scoreNotes: PianoNote[] }
type Builder = typeof buildScore
type Playback = typeof scoreToPiano

/** 発音・長さ・休符を保持したかを、旧時間重なり指標とは別にIDと実出力で確認する。 */
export function scoreIdentityDiagnostics(score: Score) {
  const logical = scoreToLogicalNotes(score)
  const ppq = scorePpq(score), midiScale = 480 / ppq
  const midi = parseMidi(scoreToMidi(score))
  const on = midi.events.filter(event => event.status === 0x90)
  const off = midi.events.filter(event => event.status === 0x80)
  assert.deepEqual(on.map(e => e.data[0]), logical.map(n => n.midi))
  assert.equal(off.length, on.length)
  for (const [i, n] of logical.entries()) {
    assert.equal(on[i].tick, n.tick * midiScale)
    assert.equal(off[i].tick, (n.tick + n.ticks) * midiScale)
    assert.ok(off[i].tick > on[i].tick)
    const pieces = score.measures.flat().filter(e => e.midi !== null && e.tick >= n.tick && e.tick < n.tick + n.ticks)
    assert.equal(pieces.reduce((total, e) => total + e.ticks, 0), n.ticks)
    assert.ok(pieces.every(e => e.midi === n.midi && e.sourceId === n.sourceId))
  }
  const sources = score.sourceNotes ?? []
  const lost = sources.filter(source => !logical.some(n => n.sourceId === source.sourceId && n.ticks > 0))
  const duplicateAttacks = sources.reduce((sum, source) => sum + Math.max(0, logical.filter(n => n.sourceId === source.sourceId).length - 1), 0)
  const added = logical.filter(n => n.sourceId === undefined || !sources.some(s => s.sourceId === n.sourceId)).length
  const changedPitches = logical.filter(n => {
    const source = sources.find(s => s.sourceId === n.sourceId)
    return source && Math.round(source.midi) !== n.midi
  }).length
  const scale = 60 / score.bpm / ppq
  const errors = logical.flatMap(n => {
    const source = sources.find(s => s.sourceId === n.sourceId)
    return source ? [{ sourceId: source.sourceId,
      onset: n.tick * scale + score.origin - source.start,
      offset: (n.tick + n.ticks) * scale + score.origin - source.end }] : []
  })
  return { lost: lost.length, lostSourceIds: lost.map(n => n.sourceId), added, duplicateAttacks, changedPitches,
    lostReattacks: lost.filter(n => {
      const index = sources.indexOf(n)
      return index > 0 && Math.round(sources[index - 1].midi) === Math.round(n.midi)
    }).length,
    maxOnsetError: Math.max(0, ...errors.map(e => Math.abs(e.onset))),
    maxOffsetError: Math.max(0, ...errors.map(e => Math.abs(e.offset))), errors,
    outputAttacksVerified: on.length, issues: score.issues ?? [] }
}

/** 消失だけの要約で誤音高・重複・誤差超過を成功に見せず、要確認も別に明示する。 */
export function summarizeIdentity(results: ReturnType<typeof scoreIdentityDiagnostics>[]) {
  const sum = (key: 'lost' | 'added' | 'duplicateAttacks' | 'changedPitches' | 'lostReattacks' | 'outputAttacksVerified') =>
    results.reduce((total, result) => total + result[key], 0)
  const counts = { lost: sum('lost'), added: sum('added'), duplicateAttacks: sum('duplicateAttacks'),
    changedPitches: sum('changedPitches'), lostReattacks: sum('lostReattacks'), outputAttacksVerified: sum('outputAttacksVerified') }
  const maxOnsetError = Math.max(0, ...results.map(r => r.maxOnsetError))
  const maxOffsetError = Math.max(0, ...results.map(r => r.maxOffsetError))
  const reviewIssues = results.reduce((total, result) => total + result.issues.length, 0)
  const preserved = !counts.lost && !counts.added && !counts.duplicateAttacks && !counts.changedPitches && !counts.lostReattacks
    && maxOnsetError <= .05 + 1e-10 && maxOffsetError <= .05 + 1e-10
  return { ...counts, maxOnsetError, maxOffsetError, reviewIssues, preserved, pass: preserved && reviewIssues === 0 }
}

/** 過去rawの採点とstageの入力・Scoreを照合し、保存音符の差し替えを黙認しない。 */
export function verifyStoredScoreInput(stage: Stage, duration: number, oldBuild: Builder, oldPlayback: Playback,
  reference: Parameters<typeof evaluateNoteEvents>[0], recorded: { performance: ReturnType<typeof evaluateNoteEvents>; score: ReturnType<typeof evaluateNoteEvents> }): void {
  assert.deepEqual(oldBuild(stage.notes, duration, 120), stage.score, '保存Scoreと旧コードの再生成が不一致')
  const scoreNotes = oldPlayback(stage.score).notes.map(n => ({ ...n, start: n.start + stage.score.origin, end: n.end + stage.score.origin }))
  assert.deepEqual(scoreNotes, stage.scoreNotes, '保存譜面再生と旧コードが不一致')
  assert.deepEqual(evaluateNoteEvents(reference, stage.notes), recorded.performance, '原音符の指標が固定rawと不一致')
  assert.deepEqual(evaluateNoteEvents(reference, scoreNotes), recorded.score, '旧Scoreの指標が固定rawと不一致')
}

/** 原音秒へ戻して旧診断を保持し、処理時間と表示断片数を測る。 */
function convert(notes: PianoNote[], duration: number, builder: Builder, playback: Playback) {
  const start = performance.now(), score = builder(notes, duration, 120), buildMs = performance.now() - start
  const output = playback(score).notes.map(n => ({ ...n, start: n.start + score.origin, end: n.end + score.origin }))
  const diagnostics = scoreDiagnostics(notes, output, duration)
  const onsetErrors = diagnostics.pairs.map(([r, e]) => output[e].start - notes[r].start)
  const offsetErrors = diagnostics.pairs.map(([r, e]) => output[e].end - notes[r].end)
  return { score, output, buildMs, diagnostics, overlapMatchedTiming: { onsetErrors, offsetErrors },
    lostReattacksByOverlap: diagnostics.lostIndices.filter(i => i > 0 && Math.round(notes[i - 1].midi) === Math.round(notes[i].midi)).length,
    eventCount: score.measures.flat().length, attacks: output.length, omittedNotes: score.omittedNotes }
}

/** 指標を省略せず保持し、原音符や個人PCMは公開結果へ含めない。 */
function comparison(notes: PianoNote[], duration: number, oldBuild: Builder, oldPlayback: Playback) {
  const beforeInput = structuredClone(notes)
  const before = convert(notes, duration, oldBuild, oldPlayback), after = convert(notes, duration, buildScore, scoreToPiano)
  assert.deepEqual(notes, beforeInput)
  const identity = scoreIdentityDiagnostics(after.score)
  const compact = ({ score: _score, output: _output, ...metrics }: ReturnType<typeof convert>) => metrics
  return { before, after, report: { inputHash: hash(JSON.stringify(notes)), inputNotes: notes.length,
    before: compact(before), after: { ...compact(after), identity } } }
}

/** 指定runだけを新しい出力先へ比較する。公開済みholdoutは歴史的回帰として明示する。 */
async function main(): Promise<void> {
  const [source, destination, baseline] = process.argv.slice(2)
  if (!source || !destination || !baseline || !resolve(destination).startsWith(resolve('output/issue22') + '/') || existsSync(destination))
    throw new Error('指定: source-run 新規output/issue22/比較先 baseline-export-root')
  const oldBuild = (await import(pathToFileURL(resolve(baseline, 'src/notation/score.ts')).href)).buildScore as Builder
  const oldPlayback = (await import(pathToFileURL(resolve(baseline, 'src/notation/score-playback.ts')).href)).scoreToPiano as Playback
  const bytes = readFileSync(`${source}/results.json`), raw = JSON.parse(bytes.toString())
  const publication = JSON.parse(readFileSync('docs/evaluation/humming-results.json', 'utf8'))
  const anchor = publication.reports.find((r: { inferenceReportSha256: string }) => r.inferenceReportSha256 === hash(bytes))
  assert.ok(anchor, '旧rawは#24公開hashと一致する必要があります')
  const baselineHashes = Object.fromEntries(['score.ts', 'score-playback.ts', 'midi.ts'].map(name => {
    const file = `src/notation/${name}`, digest = hash(readFileSync(`${baseline}/${file}`))
    assert.equal(digest, raw.sourceHashes[file], '旧コードは元runの出典と一致する必要があります')
    return [file, digest]
  }))
  const manifest = readManifest()
  assert.equal(hash(readFileSync('docs/evaluation/humming-manifest-v1.json')), raw.manifestSha256)
  validateCompletion(manifest.tracks.filter(c => c.split === raw.split).map(c => c.id), raw.rows, raw.complete)
  const rows = []
  for (const row of raw.rows) {
    const clip = manifest.tracks.find(c => c.id === row.id)!
    assert.equal(row.audioSha256, clip.sha256['input.wav'])
    const stageBytes = readFileSync(`${source}/${row.id}.stages.json`)
    const stages = JSON.parse(stageBytes.toString()) as { duration: number; stages: Record<string, Stage>; model: Stage }
    assert.equal(stages.duration, row.duration)
    for (const method of ['yin', 'basicPitch']) {
      const stage = method === 'yin' ? stages.stages.yin : stages.model
      const references = Object.fromEntries((['A1', 'A2'] as const).map(annotator => [annotator, readReference(clip, annotator)]))
      for (const [annotator, reference] of Object.entries(references))
        verifyStoredScoreInput(stage, row.duration, oldBuild, oldPlayback, reference, row.notes[method].annotations[annotator])
      const result = comparison(stage.notes, row.duration, oldBuild, oldPlayback)
      rows.push({ id: row.id, method, duration: row.duration, stageSha256: hash(stageBytes), ...result.report,
        annotations: Object.fromEntries(Object.entries(references).map(([annotator, reference]) => [annotator, {
          performance: evaluateNoteEvents(reference, stage.notes),
          before: evaluateNoteEvents(reference, result.before.output), after: evaluateNoteEvents(reference, result.after.output),
        }])) })
    }
  }
  const synthetic = [
    { id: 'cdc', notes: [[0, .2, 60], [.2, .3, 62], [.3, 1, 60]], duration: 1 },
    { id: 'reattack', notes: [[0, .46, 60], [.46, .48, 60], [.48, 1, 60]], duration: 1 },
    { id: 'long', notes: [[0, 5, 60]], duration: 5 },
  ].map(item => {
    const notes = item.notes.map(([start, end, midi]) => ({ start, end, midi, contour: [] }))
    const result = comparison(notes, item.duration, oldBuild, oldPlayback)
    return { id: item.id, input: notes, duration: item.duration, ...result.report,
      beforeScore: result.before.score, afterScore: result.after.score }
  })
  mkdirSync(destination, { recursive: true })
  const sourceFiles = ['src/notation/score.ts', 'src/notation/score-playback.ts', 'src/notation/score-editor.ts', 'src/notation/midi.ts',
    'scripts/evaluation/compare-score.ts', 'scripts/evaluation/metrics.ts', 'tests/helpers/parse-midi.ts']
  const result = { scope: raw.split === 'final-holdout' ? 'historical-holdout-regression' : 'existing-regression',
    baselineSha: readFileSync(`${baseline}/sha.txt`, 'utf8').trim(), inferenceBaselineSha: raw.baselineSha,
    inputRun: source, inputRunSha256: hash(bytes), originalHoldoutSealSha256: raw.holdoutSealSha256 ?? null,
    localSealSha256: hash(readFileSync(`${source}/seal.json`)), baselineHashes,
    sourceHashes: Object.fromEntries(sourceFiles.map(file => [file, hash(readFileSync(file))])),
    stageProvenance: 'Stage hashes recorded now; stage notes/Score and A1/A2 metrics checked against published raw. Original run did not seal stage files individually.',
    environment: { node: process.version, platform: process.platform, arch: process.arch },
    bpm: 120, identitySummary: summarizeIdentity(rows.map(row => row.after.identity)), rows, synthetic }
  const fullJson = JSON.stringify(result, null, 2)
  writeFileSync(`${destination}/comparison.json`, fullJson)
  /** 公開資料は同じ実行結果から生成する。照合pairや全誤差列はローカル完全版に保持する。 */
  const publicMetrics = (metrics: Omit<ReturnType<typeof convert>, 'score' | 'output'>) => {
    const { pairs: _pairs, lostIndices: _indices, ...diagnostics } = metrics.diagnostics
    return { attacks: metrics.attacks, omittedNotes: metrics.omittedNotes, eventCount: metrics.eventCount, buildMs: metrics.buildMs,
      diagnostics, lostReattacksByOverlap: metrics.lostReattacksByOverlap,
      overlapMatchedTiming: { maxOnsetError: Math.max(0, ...metrics.overlapMatchedTiming.onsetErrors.map(Math.abs)),
        maxOffsetError: Math.max(0, ...metrics.overlapMatchedTiming.offsetErrors.map(Math.abs)) } }
  }
  const publicRows = rows.map(row => {
    const { errors: _errors, ...identity } = row.after.identity
    return { id: row.id, method: row.method, duration: row.duration, stageSha256: row.stageSha256,
      inputHash: row.inputHash, inputNotes: row.inputNotes, before: publicMetrics(row.before), after: { ...publicMetrics(row.after), identity },
      annotations: Object.fromEntries(Object.entries(row.annotations).map(([annotator, phases]) => [annotator,
        Object.fromEntries(Object.entries(phases).map(([phase, counts]) => [phase, { onset: counts.onset, offset: counts.offset }]))])) }
  })
  const { rows: _rows, synthetic: _synthetic, ...provenance } = result
  writeFileSync(`${destination}/public-comparison.json`, JSON.stringify({ ...provenance, fullComparisonSha256: hash(fullJson), rows: publicRows,
    synthetic: synthetic.map(({ beforeScore, afterScore, input, id, duration }) => ({ id, input, duration, beforeScore, afterScore })) }, null, 2))
  console.log(JSON.stringify({ rows: rows.length, beforeLost: rows.reduce((s, r) => s + r.before.diagnostics.lost, 0),
    afterLost: rows.reduce((s, r) => s + r.after.diagnostics.lost, 0), identity: result.identitySummary }))
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) await main()
