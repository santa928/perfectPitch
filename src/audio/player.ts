import type { PianoNote } from '../analysis/notes.ts'
import { parseSoundfont, playbackPosition } from './playback-model.ts'
import { PIANO_RELEASE_SECONDS, schedulePianoVoice } from './piano-voice.ts'
import type { PianoSound, PianoVoice } from './piano-voice.ts'

const PIANO_URL =
  'https://gleitz.github.io/midi-js-soundfonts/FluidR3_GM/acoustic_grand_piano-mp3.js'
const SAMPLE_MIDIS = [33, 45, 57, 69, 81]
export type PianoStatus = 'idle' | 'loading' | 'ready' | 'error'

/** 通常は対象鍵盤そのもの、連続音高だけ従来の基準サンプルを使う。 */
function sampleMidiFor(midi: number, sound: PianoSound): number {
  return sound === 'piano'
    ? Math.max(21, Math.min(108, Math.round(midi)))
    : SAMPLE_MIDIS.reduce((a, b) => Math.abs(b - midi) < Math.abs(a - midi) ? b : a)
}

/** MIDI鍵盤番号を既存SoundFontのフラット表記へ変換する。 */
function sampleName(midi: number): string {
  const names = ['C', 'Db', 'D', 'Eb', 'E', 'F', 'Gb', 'G', 'Ab', 'A', 'Bb', 'B']
  return `${names[midi % 12]}${Math.floor(midi / 12) - 1}`
}

/** 原音・鍵盤のピアノ・連続音高を同じAudioContext時計で管理する。 */
export class VoicePlayer {
  private context: AudioContext | null = null
  private samples = new Map<number, AudioBuffer>()
  private soundfont: Record<string, string> | null = null
  private loadTask: Promise<void> | null = null
  private abort: AbortController | null = null
  private sources = new Set<AudioBufferSourceNode>()
  private generation = 0
  private startedAt = 0
  private offset = 0
  private duration = 0
  private endTimer: ReturnType<typeof setTimeout> | null = null
  private active = false
  private preparing = false
  private voices = new Set<PianoVoice>()
  onStatus: (status: PianoStatus) => void = () => {}
  onEnded: () => void = () => {}
  onInterrupted: () => void = () => {}

  /** ユーザー操作の同期部分で呼び出し、ブラウザの音声再生許可を取得する。 */
  async unlock(): Promise<void> {
    if (!this.context || this.context.state === 'closed') {
      this.context = new AudioContext()
      this.context.onstatechange = () => {
        if (
          (this.active || this.preparing) &&
          this.context?.state !== 'running'
        ) {
          this.stop()
          this.onInterrupted()
        }
      }
    }
    await this.context.resume()
    if (this.context.state !== 'running')
      throw new Error('音声を再生できません。もう一度再生を押してください。')
  }

  /** 必要な鍵盤だけをデコードして再利用する。取得・デコード失敗後も次回に再試行できる。 */
  private loadPiano(generation: number, requested: readonly number[]): Promise<void> {
    const missing = [...new Set(requested)].filter(midi => !this.samples.has(midi))
    if (missing.length === 0) {
      this.onStatus('ready')
      return Promise.resolve()
    }
    if (this.loadTask) return this.loadTask
    const context = this.context!
    const abort = new AbortController()
    this.abort = abort
    this.onStatus('loading')
    const timeout = setTimeout(() => abort.abort(), 20000)
    const task = (async () => {
      if (!this.soundfont) {
        const response = await fetch(PIANO_URL, { signal: abort.signal })
        if (generation !== this.generation || abort.signal.aborted)
          throw new DOMException('中止', 'AbortError')
        if (!response.ok) throw new Error('ピアノ音源を取得できませんでした。')
        const text = await response.text()
        if (generation !== this.generation || abort.signal.aborted)
          throw new DOMException('中止', 'AbortError')
        this.soundfont = parseSoundfont(text)
      }
      const data = this.soundfont
      const buffers = await Promise.all(
        missing.map(async (midi) => {
          const uri = data[sampleName(midi)]
          if (!uri) throw new Error('必要なピアノ音がありません。')
          const raw = atob(uri.split(',')[1])
          const bytes = Uint8Array.from(raw, (character) =>
            character.charCodeAt(0),
          )
          const buffer = await context.decodeAudioData(bytes.buffer)
          return [midi, buffer] as const
        }),
      )
      if (generation !== this.generation || abort.signal.aborted)
        throw new DOMException('中止', 'AbortError')
      for (const [midi, buffer] of buffers) this.samples.set(midi, buffer)
      this.onStatus('ready')
    })()
      .catch((error) => {
        if (generation === this.generation && this.abort === abort) {
          this.soundfont = null
          this.onStatus('error')
        }
        throw error
      })
      .finally(() => {
        clearTimeout(timeout)
        if (this.loadTask === task) this.loadTask = null
        if (this.abort === abort) this.abort = null
      })
    this.loadTask = task
    return task
  }

  /**
   * 原音または音符を再生。音符のみ別の譜面長を指定でき、原音は常にPCM長を使う。
   * 読み込み中の停止・切替を世代番号で無効化し、位置と終了を同じ長さで管理する。
   */
  async play(
    pcm: Float32Array,
    sampleRate: number,
    notes: PianoNote[] | null,
    offset = 0,
    playbackDuration?: number,
    sound: PianoSound = 'piano',
  ): Promise<boolean> {
    const duration = notes !== null && playbackDuration !== undefined
      ? playbackDuration : pcm.length / sampleRate
    // ブラウザのsetTimeoutが32bit範囲を超えて即終了する値を拒否する。
    if (!Number.isFinite(duration) || duration < 0 || duration > 2_147_483 || !Number.isFinite(offset))
      throw new RangeError('再生時間と開始位置に有効な秒数を指定してください。')
    this.stop()
    const generation = this.generation
    try {
      await this.unlock()
      if (generation !== this.generation) return false
      this.preparing = true
      if (notes) await this.loadPiano(generation, notes.length
        ? notes.map(note => sampleMidiFor(note.midi, sound)) : SAMPLE_MIDIS)
    } catch (error) {
      if (generation !== this.generation) return false
      this.preparing = false
      throw error
    }
    if (generation !== this.generation) return false
    const context = this.context!
    if (context.state !== 'running') {
      this.stop()
      this.onInterrupted()
      return false
    }
    this.duration = duration
    this.offset = Math.max(0, Math.min(offset, this.duration))
    this.startedAt = context.currentTime + 0.04
    try {
      if (notes === null) {
        const buffer = context.createBuffer(1, pcm.length, sampleRate)
        buffer.copyToChannel(new Float32Array(pcm), 0)
        const source = this.source(buffer)
        source.connect(context.destination)
        source.start(this.startedAt, this.offset)
      } else {
        for (const note of notes) {
          if (note.end <= this.offset) continue
          const sampleMidi = sampleMidiFor(note.midi, sound)
          let voice: PianoVoice | undefined
          voice = schedulePianoVoice(context, {
            sample: this.samples.get(sampleMidi)!,
            sampleMidi,
            note,
            startedAt: this.startedAt,
            offset: this.offset,
            sound,
            onEnded: () => {
              if (voice) this.voices.delete(voice)
            },
          })
          this.voices.add(voice)
        }
      }
      this.preparing = false
      this.active = true
      const tail = notes !== null && sound === 'piano' ? PIANO_RELEASE_SECONDS : 0
      this.endTimer = setTimeout(
        () => {
          this.stop()
          this.onEnded()
        },
        (this.duration - this.offset + 0.06 + tail) * 1000,
      )
      return true
    } catch (error) {
      this.stop()
      throw error
    }
  }

  /** 作成した音源を追跡し、停止時に予約済みの音も止める。 */
  private source(buffer: AudioBuffer): AudioBufferSourceNode {
    const source = this.context!.createBufferSource()
    source.buffer = buffer
    this.sources.add(source)
    source.onended = () => {
      source.disconnect()
      this.sources.delete(source)
    }
    return source
  }

  /** 描画頻度に依存しない再生カーソルを返す。 */
  position(): number {
    return this.active && this.context
      ? playbackPosition(
          this.context.currentTime,
          this.startedAt,
          this.offset,
          this.duration,
        )
      : this.offset
  }

  /** 再生・予約音・取得中のネットワークを中止する。 */
  stop(): void {
    this.offset = this.position()
    this.generation++
    this.active = false
    this.preparing = false
    if (this.endTimer) clearTimeout(this.endTimer)
    this.endTimer = null
    this.abort?.abort()
    this.abort = null
    this.loadTask = null
    for (const voice of this.voices) voice.stop()
    this.voices.clear()
    for (const source of this.sources) {
      source.onended = null
      try {
        source.stop()
      } catch {
        /* Already ended. */
      }
      source.disconnect()
    }
    this.sources.clear()
  }

  /** ページ終了時に音声リソースを解放する。 */
  dispose(): void {
    this.stop()
    this.samples.clear()
    this.soundfont = null
    if (this.context) {
      this.context.onstatechange = null
      void this.context.close()
    }
    this.context = null
  }
}
