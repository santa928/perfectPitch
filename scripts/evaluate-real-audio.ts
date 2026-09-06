import { readFileSync, writeFileSync } from 'node:fs'
import { performance } from 'node:perf_hooks'
import { basename, join } from 'node:path'
import {
  analyze,
  ANALYSIS_SETTINGS,
  type AnalysisMode,
  type PitchFrame,
} from '../src/analysis/pipeline.ts'
import { buildNotes } from '../src/analysis/notes.ts'
import { autoCorrelate } from '../tests/fixtures/legacy-detector.ts'

type Wav = { samples: Float32Array; sampleRate: number; duration: number }
type LegacyFrame = { accepted: boolean; midi: number | null }

const CALIBRATION_SILENCE_SECONDS = 0.4
const LEGACY_WINDOW_SAMPLES = 2048
const LEGACY_MIN_RMS = 0.008
const LEGACY_MIN_CONFIDENCE = 0.25
const fixtures: { filename: string; mode: AnalysisMode; role: string }[] = [
  { filename: 'pjs056_song.wav', mode: 'song', role: '公式個別サンプル歌声' },
  { filename: 'pjs012_song.wav', mode: 'song', role: '楽譜上の低音域' },
  { filename: 'pjs068_song.wav', mode: 'song', role: '楽譜上のロングトーン' },
  { filename: 'pjs087_song.wav', mode: 'song', role: '楽譜上の高音域' },
  { filename: 'pjs091_song.wav', mode: 'song', role: '短い歌唱' },
  { filename: 'pjs056_speech.wav', mode: 'speech', role: '通常の日本語話声' },
]

/** 24-bit little-endian mono PCM WAVをWeb Audio相当のFloat32へ変換する。 */
function readPcm24MonoWav(path: string): Wav {
  const bytes = readFileSync(path)
  if (
    bytes.toString('ascii', 0, 4) !== 'RIFF' ||
    bytes.toString('ascii', 8, 12) !== 'WAVE'
  ) {
    throw new Error(`${path}: RIFF/WAVEではありません`)
  }
  let format: {
    code: number
    channels: number
    sampleRate: number
    bits: number
  } | null = null
  let dataOffset = -1
  let dataSize = -1
  for (let offset = 12; offset + 8 <= bytes.length; ) {
    const id = bytes.toString('ascii', offset, offset + 4)
    const size = bytes.readUInt32LE(offset + 4)
    const body = offset + 8
    if (body + size > bytes.length)
      throw new Error(`${path}: 壊れたWAVチャンクです`)
    if (id === 'fmt ') {
      format = {
        code: bytes.readUInt16LE(body),
        channels: bytes.readUInt16LE(body + 2),
        sampleRate: bytes.readUInt32LE(body + 4),
        bits: bytes.readUInt16LE(body + 14),
      }
    } else if (id === 'data') {
      dataOffset = body
      dataSize = size
    }
    offset = body + size + (size % 2)
  }
  if (!format || dataOffset < 0 || dataSize < 0)
    throw new Error(`${path}: fmt/dataチャンクがありません`)
  if (format.code !== 1 || format.channels !== 1 || format.bits !== 24) {
    throw new Error(`${path}: 期待するmono 24-bit PCMではありません`)
  }
  const samples = new Float32Array(Math.floor(dataSize / 3))
  for (
    let index = 0, offset = dataOffset;
    index < samples.length;
    index++, offset += 3
  ) {
    let sample = bytes.readUIntLE(offset, 3)
    if (sample & 0x800000) sample -= 0x1000000
    samples[index] = sample / 0x800000
  }
  return {
    samples,
    sampleRate: format.sampleRate,
    duration: samples.length / format.sampleRate,
  }
}

/** 発声を校正区間から確実に外すため、入力先頭へデジタル無音を追加する。 */
function withCalibrationSilence(
  samples: Float32Array,
  sampleRate: number,
): Float32Array {
  const prefixSamples = Math.round(sampleRate * CALIBRATION_SILENCE_SECONDS)
  const prepared = new Float32Array(prefixSamples + samples.length)
  prepared.set(samples, prefixSamples)
  return prepared
}

/** 新パイプラインのフレーム中心と同じ時刻で旧2048サンプル窓を評価する。 */
function evaluateLegacyAtFrames(
  samples: Float32Array,
  sampleRate: number,
  frames: PitchFrame[],
): LegacyFrame[] {
  const half = LEGACY_WINDOW_SAMPLES / 2
  return frames.map((frame) => {
    const center = Math.round(frame.t * sampleRate)
    const start = center - half
    if (start < 0 || start + LEGACY_WINDOW_SAMPLES > samples.length) {
      return { accepted: false, midi: null }
    }
    const window = samples.subarray(start, start + LEGACY_WINDOW_SAMPLES)
    let energy = 0
    for (const sample of window) energy += sample * sample
    const rms = Math.sqrt(energy / window.length)
    if (rms < LEGACY_MIN_RMS) return { accepted: false, midi: null }
    const result = autoCorrelate(window, sampleRate)
    const accepted =
      result.frequency !== null && result.confidence >= LEGACY_MIN_CONFIDENCE
    return {
      accepted,
      midi:
        accepted && result.frequency !== null
          ? 69 + 12 * Math.log2(result.frequency / 440)
          : null,
    }
  })
}

/** 実音声の正解ラベルを仮定せず、状態・出力範囲・音符化件数だけを集計する。 */
function summarize(
  frames: PitchFrame[],
  samples: Float32Array,
  sampleRate: number,
  mode: AnalysisMode,
  originalDuration: number,
  prefixSeconds: number,
): Record<string, unknown> {
  const end = prefixSeconds + originalDuration
  const clipFrames = frames.filter(
    (frame) => frame.t >= prefixSeconds && frame.t <= end,
  )
  const stateCounts = Object.fromEntries(
    ['voiced', 'unvoiced', 'uncertain', 'silence', 'calibrating'].map(
      (state) => [
        state,
        clipFrames.filter((frame) => frame.state === state).length,
      ],
    ),
  )
  const voiced = clipFrames.filter(
    (frame): frame is PitchFrame & { frequency: number; midi: number } =>
      frame.state === 'voiced' &&
      frame.frequency !== null &&
      frame.midi !== null,
  )
  const frequencies = voiced.map((frame) => frame.frequency)
  const midis = voiced.map((frame) => frame.midi)
  const legacy = evaluateLegacyAtFrames(samples, sampleRate, clipFrames)
  const legacyMidis = legacy.flatMap((frame) =>
    frame.midi === null ? [] : [frame.midi],
  )
  let both = 0
  let newOnly = 0
  let legacyOnly = 0
  for (let index = 0; index < clipFrames.length; index++) {
    const newAccepted = clipFrames[index].state === 'voiced'
    const oldAccepted = legacy[index].accepted
    if (newAccepted && oldAccepted) both++
    else if (newAccepted) newOnly++
    else if (oldAccepted) legacyOnly++
  }
  const hopSeconds = ANALYSIS_SETTINGS[mode].hopMs / 1000
  const durationWithPrefix = prefixSeconds + originalDuration
  const continuousNoteCount = buildNotes(
    frames,
    mode,
    'continuous',
    durationWithPrefix,
  ).length
  const roundedNoteCount = buildNotes(
    frames,
    mode,
    'rounded',
    durationWithPrefix,
  ).length
  const voicedSeconds = voiced.length * hopSeconds
  const periodicityThresholds = [0.7, 0.8, 0.85, 0.9]
  const rawPeriodicityAtLeast = Object.fromEntries(
    periodicityThresholds.map((threshold) => {
      const count = clipFrames.filter(
        (frame) => frame.periodicity >= threshold,
      ).length
      return [
        threshold.toFixed(2),
        {
          count,
          fraction: count / clipFrames.length,
          seconds: count * hopSeconds,
        },
      ]
    }),
  )
  const rmsRanges = [
    {
      name: 'quietBelow0.001',
      includes: (rms: number): boolean => rms < 0.001,
    },
    {
      name: 'active0.001To0.008',
      includes: (rms: number): boolean => rms >= 0.001 && rms < 0.008,
    },
    {
      name: 'activeAtOrAbove0.008',
      includes: (rms: number): boolean => rms >= 0.008,
    },
  ]
  const rmsFrameDistribution = Object.fromEntries(
    rmsRanges.map((range) => {
      const count = clipFrames.filter((frame) =>
        range.includes(frame.rms),
      ).length
      return [
        range.name,
        {
          count,
          fraction: count / clipFrames.length,
          seconds: count * hopSeconds,
        },
      ]
    }),
  )
  return {
    frameCount: clipFrames.length,
    stateCounts,
    voicedFraction: voiced.length / clipFrames.length,
    estimatedVoicedSeconds: voicedSeconds,
    estimatedFrequencyHzRange: frequencies.length
      ? [Math.min(...frequencies), Math.max(...frequencies)]
      : null,
    estimatedMidiRange: midis.length
      ? [Math.min(...midis), Math.max(...midis)]
      : null,
    continuousNoteCount,
    roundedNoteCount,
    continuousNotesPerEstimatedVoicedSecond:
      voicedSeconds > 0 ? continuousNoteCount / voicedSeconds : null,
    roundedNotesPerEstimatedVoicedSecond:
      voicedSeconds > 0 ? roundedNoteCount / voicedSeconds : null,
    rawPeriodicityAtLeast,
    rmsFrameDistribution,
    legacyOfflineEmulation: {
      acceptedFraction:
        legacy.filter((frame) => frame.accepted).length / legacy.length,
      estimatedMidiRange: legacyMidis.length
        ? [Math.min(...legacyMidis), Math.max(...legacyMidis)]
        : null,
      alignedFrameCounts: { both, newOnly, legacyOnly },
      settings: {
        windowSamples: LEGACY_WINDOW_SAMPLES,
        minRms: LEGACY_MIN_RMS,
        minConfidence: LEGACY_MIN_CONFIDENCE,
      },
    },
  }
}

const started = performance.now()
const results = fixtures.map((fixture) => {
  const path = join('tests/fixtures/downloads', fixture.filename)
  const wav = readPcm24MonoWav(path)
  const prepared = withCalibrationSilence(wav.samples, wav.sampleRate)
  const preparedFrames = analyze(prepared, wav.sampleRate, fixture.mode)
  const unmodifiedFrames = analyze(wav.samples, wav.sampleRate, fixture.mode)
  return {
    ...fixture,
    path,
    sampleRate: wav.sampleRate,
    originalDurationSeconds: wav.duration,
    withPrependedCalibrationSilence: summarize(
      preparedFrames,
      prepared,
      wav.sampleRate,
      fixture.mode,
      wav.duration,
      CALIBRATION_SILENCE_SECONDS,
    ),
    unmodifiedClip: summarize(
      unmodifiedFrames,
      wav.samples,
      wav.sampleRate,
      fixture.mode,
      wav.duration,
      0,
    ),
  }
})

const output = {
  date: new Date().toISOString(),
  environment: {
    node: process.version,
    platform: process.platform,
    architecture: process.arch,
  },
  calibration: {
    prependedDigitalSilenceSeconds: CALIBRATION_SILENCE_SECONDS,
    reason:
      'PitchAnalyzerの先頭0.3秒校正へ発声を混ぜないため。実マイクの環境音校正とは異なる。',
  },
  interpretation: [
    '正解F0ラベルがないため、精度・正解率・cents誤差は算出しない。',
    'voicedFractionは元クリップ時間内に中心を持つ10ms間隔フレームに対する比率。',
    'estimatedVoicedSecondsは有声フレーム数×10msで、連続区間の厳密な長さではない。',
    'legacyOfflineEmulationは旧UIのrAF頻度・平滑化・4フレームごとの記録を再現しない。',
    '旧検出器との件数差と推定レンジは、どちらが正しいかを示さない。',
    'MusicXMLはサンプル選定だけに使い、解析結果の正解ラベルには使わない。',
  ],
  elapsedMilliseconds: performance.now() - started,
  results,
}

writeFileSync(
  'docs/evaluation/real-audio-results.json',
  `${JSON.stringify(output, null, 2)}\n`,
)
for (const result of results) {
  const summary = result.withPrependedCalibrationSilence
  console.log(
    JSON.stringify({
      file: basename(result.path),
      role: result.role,
      mode: result.mode,
      duration: result.originalDurationSeconds,
      voicedFraction: summary.voicedFraction,
      estimatedVoicedSeconds: summary.estimatedVoicedSeconds,
      estimatedFrequencyHzRange: summary.estimatedFrequencyHzRange,
      continuousNoteCount: summary.continuousNoteCount,
      roundedNoteCount: summary.roundedNoteCount,
      continuousNotesPerEstimatedVoicedSecond:
        summary.continuousNotesPerEstimatedVoicedSecond,
      rawPeriodicityAtLeast: summary.rawPeriodicityAtLeast,
      rmsFrameDistribution: summary.rmsFrameDistribution,
      states: summary.stateCounts,
      legacy: summary.legacyOfflineEmulation,
    }),
  )
}
