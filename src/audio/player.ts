import type { PianoNote } from '../analysis/notes.ts'
import { parseSoundfont, playbackPosition } from './playback-model.ts'
import { schedulePianoVoice } from './piano-voice.ts'
import type { PianoVoice } from './piano-voice.ts'

const PIANO_URL =
  'https://gleitz.github.io/midi-js-soundfonts/FluidR3_GM/acoustic_grand_piano-mp3.js'
const SAMPLE_MIDIS = [33, 45, 57, 69, 81]
const SAMPLE_NAMES = ['A1', 'A2', 'A3', 'A4', 'A5']
export type PianoStatus = 'idle' | 'loading' | 'ready' | 'error'

/** 原音と連続音高のサンプル再生を同じAudioContext時計で管理する。 */
export class VoicePlayer {
  private context: AudioContext | null = null
  private samples = new Map<number, AudioBuffer>()
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

  /** 外部音源はデータとして取得。タイムアウトとキャンセル時も次回に再試行できる。 */
  private loadPiano(generation: number): Promise<void> {
    if (this.samples.size === SAMPLE_MIDIS.length) return Promise.resolve()
    if (this.loadTask) return this.loadTask
    const context = this.context!
    const abort = new AbortController()
    this.abort = abort
    this.onStatus('loading')
    const timeout = setTimeout(() => abort.abort(), 20000)
    const task = (async () => {
      const response = await fetch(PIANO_URL, { signal: abort.signal })
      if (generation !== this.generation || abort.signal.aborted)
        throw new DOMException('中止', 'AbortError')
      if (!response.ok) throw new Error('ピアノ音源を取得できませんでした。')
      const text = await response.text()
      if (generation !== this.generation || abort.signal.aborted)
        throw new DOMException('中止', 'AbortError')
      const data = parseSoundfont(text)
      const buffers = await Promise.all(
        SAMPLE_NAMES.map(async (name, index) => {
          const uri = data[name]
          if (!uri) throw new Error('必要なピアノ音がありません。')
          const raw = atob(uri.split(',')[1])
          const bytes = Uint8Array.from(raw, (character) =>
            character.charCodeAt(0),
          )
          const buffer = await context.decodeAudioData(bytes.buffer)
          return [SAMPLE_MIDIS[index], buffer] as const
        }),
      )
      if (generation !== this.generation || abort.signal.aborted)
        throw new DOMException('中止', 'AbortError')
      this.samples = new Map(buffers)
      this.onStatus('ready')
    })()
      .catch((error) => {
        if (generation === this.generation && this.abort === abort)
          this.onStatus('error')
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

  /** 原音または音符を再生。読み込み中の停止・切替を世代番号で無効化する。 */
  async play(
    pcm: Float32Array,
    sampleRate: number,
    notes: PianoNote[] | null,
    offset = 0,
  ): Promise<boolean> {
    this.stop()
    const generation = this.generation
    try {
      await this.unlock()
      if (generation !== this.generation) return false
      this.preparing = true
      if (notes) await this.loadPiano(generation)
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
    this.duration = pcm.length / sampleRate
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
          const sampleMidi = SAMPLE_MIDIS.reduce((a, b) =>
            Math.abs(b - note.midi) < Math.abs(a - note.midi) ? b : a,
          )
          let voice: PianoVoice | undefined
          voice = schedulePianoVoice(context, {
            sample: this.samples.get(sampleMidi)!,
            sampleMidi,
            note,
            startedAt: this.startedAt,
            offset: this.offset,
            onEnded: () => {
              if (voice) this.voices.delete(voice)
            },
          })
          this.voices.add(voice)
        }
      }
      this.preparing = false
      this.active = true
      this.endTimer = setTimeout(
        () => {
          this.stop()
          this.onEnded()
        },
        (this.duration - this.offset + 0.06) * 1000,
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
    if (this.context) {
      this.context.onstatechange = null
      void this.context.close()
    }
    this.context = null
  }
}
