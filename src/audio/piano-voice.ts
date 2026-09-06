import type { PianoNote } from '../analysis/notes.ts'
import { rateForMidi } from './playback-model.ts'

export type PianoVoice = {
  source: AudioBufferSourceNode
  gain: GainNode
  stop: () => void
}
type VoiceOptions = {
  sample: AudioBuffer
  sampleMidi: number
  note: PianoNote
  startedAt: number
  offset: number
  onEnded?: () => void
}

type SustainSample = { buffer: AudioBuffer; loopStart: number; loopEnd: number }
const sustainedSamples = new WeakMap<AudioBuffer, SustainSample>()

/** 指定位置付近の上向きゼロ交差を選び、ループ境界の振幅差を小さくする。 */
function loopPoint(
  data: Float32Array,
  desired: number,
  radius: number,
): number {
  let selected = desired,
    distance = Infinity
  for (
    let i = Math.max(1, desired - radius);
    i < Math.min(data.length - 1, desired + radius);
    i++
  ) {
    if (data[i - 1] <= 0 && data[i] > 0 && Math.abs(i - desired) < distance) {
      selected = i
      distance = Math.abs(i - desired)
    }
  }
  return selected
}

/** アタック後の明示的な持続区間を作り、末尾10msをループ開始前の波形へクロスフェードする。 */
function sustainSample(
  context: BaseAudioContext,
  sample: AudioBuffer,
  sampleMidi: number,
): SustainSample {
  const cached = sustainedSamples.get(sample)
  if (cached) return cached
  if (sample.length < 8) throw new Error('ピアノ音源が短すぎます。')
  const sr = sample.sampleRate
  const radius = Math.max(
    1,
    Math.ceil(sr / (440 * 2 ** ((sampleMidi - 69) / 12))),
  )
  const channel = sample.getChannelData(0)
  const start = loopPoint(
    channel,
    Math.floor(Math.min(0.35, sample.duration * 0.25) * sr),
    radius,
  )
  const end = loopPoint(
    channel,
    Math.floor(Math.min(1.3, sample.duration * 0.75) * sr),
    radius,
  )
  if (end <= start) throw new Error('ピアノ音源の持続区間を作れません。')
  const fade = Math.min(
    Math.round(sr * 0.01),
    Math.floor((end - start) / 4),
    start,
  )
  const buffer = context.createBuffer(
    sample.numberOfChannels,
    sample.length,
    sr,
  )
  for (let ch = 0; ch < sample.numberOfChannels; ch++) {
    const original = sample.getChannelData(ch),
      data = buffer.getChannelData(ch)
    data.set(original)
    for (let i = 0; i < fade; i++) {
      const mix = (i + 1) / fade
      data[end - fade + i] =
        original[end - fade + i] * (1 - mix) + original[start - fade + i] * mix
    }
  }
  const prepared = { buffer, loopStart: start / sr, loopEnd: end / sr }
  sustainedSamples.set(sample, prepared)
  return prepared
}

/** PCM sampleを録音時刻のcontourで発音する。本番とOfflineAudioContext評価で同じ予約処理を使う。 */
export function schedulePianoVoice(
  context: BaseAudioContext,
  options: VoiceOptions,
): PianoVoice {
  const { sample, sampleMidi, note, startedAt, offset, onEnded } = options
  const start = Math.max(note.start, offset)
  const when = startedAt + start - offset
  const end = startedAt + note.end - offset
  const source = context.createBufferSource()
  const sustain = sustainSample(context, sample, sampleMidi)
  source.buffer = sustain.buffer
  source.loop = true
  source.loopStart = sustain.loopStart
  source.loopEnd = sustain.loopEnd
  const gain = context.createGain()
  const attack = Math.min(0.008, (end - when) / 3)
  const release = Math.min(0.012, (end - when) / 3)
  gain.gain.setValueAtTime(0, when)
  gain.gain.linearRampToValueAtTime(0.65, when + attack)
  gain.gain.setValueAtTime(0.65, end - release)
  gain.gain.linearRampToValueAtTime(0, end)
  source.connect(gain).connect(context.destination)
  const previous = note.contour.filter((point) => point.t <= start).at(-1)
  source.playbackRate.setValueAtTime(
    rateForMidi(previous?.midi ?? note.midi, sampleMidi),
    when,
  )
  for (const point of note.contour) {
    if (point.t > start && point.t < note.end)
      source.playbackRate.linearRampToValueAtTime(
        rateForMidi(point.midi, sampleMidi),
        startedAt + point.t - offset,
      )
  }
  let ended = false
  /** 自然終了と明示停止のどちらでもsource/gainを一度だけ切断する。 */
  const cleanup = (): void => {
    if (ended) return
    ended = true
    source.onended = null
    source.disconnect()
    gain.disconnect()
    onEnded?.()
  }
  source.onended = cleanup
  const voice = {
    source,
    gain,
    stop: () => {
      try {
        source.stop()
      } catch {
        /* Already ended. */
      }
      cleanup()
    },
  }
  try {
    source.start(when)
    source.stop(end)
  } catch (error) {
    voice.stop()
    throw error
  }
  return voice
}
