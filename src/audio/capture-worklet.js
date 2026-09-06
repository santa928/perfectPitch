const DEFAULT_CHUNK_SIZE = 1024
const DEFAULT_MAX_SAMPLES = 48000 * 60

if (
  typeof globalThis.AudioWorkletProcessor !== 'undefined' &&
  typeof globalThis.registerProcessor === 'function'
) {
  /** PCM だけを mono Float32Array として収集する AudioWorklet processor。 */
  class PcmCaptureProcessor extends globalThis.AudioWorkletProcessor {
    constructor(options = {}) {
      super()
      const processorOptions = options.processorOptions ?? {}
      this.chunkSize = positiveInteger(
        processorOptions.chunkSize,
        DEFAULT_CHUNK_SIZE,
      )
      this.maxSamples = positiveInteger(
        processorOptions.maxSamples,
        DEFAULT_MAX_SAMPLES,
      )
      this.buffer = new Float32Array(this.chunkSize)
      this.buffered = 0
      this.totalSamples = 0
      this.stopped = false
      this.port.onmessage = (event) => {
        if (event.data?.type !== 'stop') return
        this.stopped = true
        this.flush()
        this.port.postMessage({
          type: 'stopped',
          totalSamples: this.totalSamples,
        })
      }
    }

    /** 入力チャンネルを平均して mono 化し、固定長の PCM chunk を通知する。 */
    process(inputs) {
      if (this.stopped) return false
      const channels = inputs[0]
      if (!channels || channels.length === 0) return true
      const frameCount = channels[0]?.length ?? 0

      for (
        let frame = 0;
        frame < frameCount && this.totalSamples < this.maxSamples;
        frame += 1
      ) {
        let sample = 0
        for (const channel of channels) sample += channel[frame] ?? 0
        this.buffer[this.buffered] = sample / channels.length
        this.buffered += 1
        this.totalSamples += 1
        if (this.buffered === this.chunkSize) this.flush()
      }

      if (this.totalSamples >= this.maxSamples) {
        this.stopped = true
        this.flush()
        this.port.postMessage({
          type: 'limit',
          totalSamples: this.totalSamples,
        })
        return false
      }
      return true
    }

    /** 端数を含む現在の chunk を所有権移譲して送る。 */
    flush() {
      if (this.buffered === 0) return
      const samples = this.buffer.slice(0, this.buffered)
      this.port.postMessage({ type: 'samples', samples }, [samples.buffer])
      this.buffered = 0
    }
  }

  globalThis.registerProcessor('pcm-capture', PcmCaptureProcessor)
}

/** processor option を安全な正整数へ正規化する。 */
function positiveInteger(value, fallback) {
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback
}

// Vite の `?url` import と Node の境界テストの双方で URL として扱える。
export default import.meta.url
