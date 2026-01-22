import './style.css'

type StatusState = 'idle' | 'working' | 'success' | 'error'

type AudioContextClass = typeof AudioContext

type PitchResult = {
  frequency: number | null
  confidence: number
}

type GaugeLevel = 'off' | 'good' | 'ok' | 'bad'

type PitchMetrics = {
  frequency: number
  confidence: number
  note: string
  centsFromTarget: number
}

type RecordedFrame = {
  t: number
  frequency: number | null
  confidence: number
  cents: number | null
  note: string | null
}

type SoundfontModule = typeof import('soundfont-player')
type SoundfontInstrument = Awaited<ReturnType<SoundfontModule['instrument']>>

type ToneStatus = 'idle' | 'loading' | 'ready' | 'error'
type MelodyEvent = {
  midi: number | null
  duration: number
}

const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B']
const SOLFEGE_NAMES = ['ド', 'ド#', 'レ', 'レ#', 'ミ', 'ファ', 'ファ#', 'ソ', 'ソ#', 'ラ', 'ラ#', 'シ']

const MIN_FREQUENCY = 80
const MAX_FREQUENCY = 1000
const MIN_CONFIDENCE = 0.25
const SMOOTHING = 0.2
const TARGET_START_MIDI = 48
const TARGET_END_MIDI = 83
const MAX_GAUGE_CENTS = 50
const RECORD_SAMPLE_EVERY = 6
const MAX_REVIEW_LINES = 140
const MELODY_STEP_SECONDS = 0.1

const SOUND_FONT_BASE_URL = 'https://gleitz.github.io/midi-js-soundfonts/'
const SOUND_FONT_NAME = 'FluidR3_GM'
const SOUND_FONT_FORMAT = 'mp3'
const SOUND_FONT_INSTRUMENT = 'acoustic_grand_piano'
const SOUND_FONT_NOTES = Array.from(
  { length: TARGET_END_MIDI - Math.max(0, TARGET_START_MIDI - 12) + 1 },
  (_, index) => Math.max(0, TARGET_START_MIDI - 12) + index,
)

const app = document.querySelector<HTMLDivElement>('#app')
if (!app) {
  throw new Error('App root element not found')
}

app.innerHTML = `
  <main class="app">
    <header class="header">
      <p class="eyebrow">MVP</p>
      <h1>perfectPitch</h1>
      <p class="subtitle">
        「開始」ボタンでマイクを許可し、音名/Hz/centsを推定します。
      </p>
    </header>

    <section class="panel">
      <div class="status">
        <span id="statusPill" class="status-pill" data-state="idle">READY</span>
        <p id="statusText" class="status-text">開始ボタンを押してください。</p>
      </div>

      <div class="actions">
        <button id="startButton" class="primary" type="button">開始</button>
        <button id="retryButton" class="ghost" type="button" hidden>再試行</button>
      </div>

      <div class="tone-actions">
        <button id="playToneButton" class="secondary" type="button">基準音を鳴らす</button>
        <button id="playOctaveButton" class="secondary" type="button">1オク下を鳴らす</button>
      </div>
      <p id="toneStatus" class="tone-status" data-state="idle">ピアノ音は未読み込み</p>

      <div class="recording">
        <div class="recording-info">
          <div class="recording-label">RECORDING</div>
          <div id="recordStatus" class="recording-status">停止中</div>
        </div>
        <div class="recording-actions">
          <button id="recordButton" class="accent" type="button">録音開始</button>
          <button id="playRecordButton" class="ghost" type="button" disabled>再生</button>
        </div>
        <audio id="recordedAudio" class="recorded-audio" controls hidden></audio>
      </div>

      <div class="display">
        <div class="current">
          <div class="current-label">CURRENT NOTE</div>
          <div id="currentNote" class="current-note">…</div>
        </div>
        <div class="target">
          <div class="target-label">TARGET</div>
          <div class="target-row">
            <select id="targetSelect" class="target-select" aria-label="ターゲット音"></select>
          </div>
        </div>
      </div>

      <div class="metrics" data-low="true">
        <div class="metric">
          <div class="metric-label">FREQ</div>
          <div id="freqValue" class="metric-value">…</div>
        </div>
        <div class="metric">
          <div class="metric-label">CENTS (TARGET)</div>
          <div id="centsValue" class="metric-value">…</div>
        </div>
        <div class="metric">
          <div class="metric-label">CONF</div>
          <div id="confidenceValue" class="metric-value">--%</div>
        </div>
      </div>

      <div id="gauge" class="gauge" data-level="off">
        <div class="gauge-bar">
          <div class="gauge-track"></div>
          <div id="gaugeNeedle" class="gauge-needle"></div>
        </div>
        <div id="gaugeLabel" class="gauge-label">NO SIGNAL</div>
        <div class="gauge-scale">
          <span>-50¢</span>
          <span>0</span>
          <span>+50¢</span>
        </div>
      </div>

      <div class="debug">
        <div class="debug-title">波形（先頭48サンプル）</div>
        <pre id="waveform" class="debug-output">-</pre>
      </div>
    </section>

    <section class="review">
      <h2>録音の振り返り</h2>
      <div class="review-grid">
        <div class="review-card review-actions">
          <div class="review-label">メロディ</div>
          <div class="melody-controls">
            <button id="playMelodyButton" class="secondary" type="button" disabled>メロディ再生</button>
            <label class="melody-speed">
              <span>再生速度</span>
              <select id="melodySpeedSelect" class="melody-speed-select" aria-label="メロディ再生速度">
                <option value="0.5">0.5x</option>
                <option value="0.75">0.75x</option>
                <option value="1" selected>1x</option>
                <option value="1.25">1.25x</option>
                <option value="1.5">1.5x</option>
              </select>
            </label>
          </div>
          <p class="review-hint">録音→停止後にメロディ再生できます。</p>
        </div>
        <div class="review-card">
          <div class="review-label">簡易統計</div>
          <div id="reviewStats" class="review-stats">-</div>
        </div>
        <div class="review-card">
          <div class="review-label">スコア</div>
          <div id="reviewScore" class="review-stats">-</div>
        </div>
        <div class="review-card">
          <div class="review-label">今日の課題</div>
          <div id="reviewChallenge" class="review-stats">-</div>
        </div>
        <div class="review-card review-wide">
          <div class="review-label">時系列（cents）</div>
          <canvas id="reviewCanvas" class="review-canvas" width="640" height="200"></canvas>
        </div>
      </div>
      <pre id="reviewList" class="review-list">-</pre>
    </section>

    <section class="notes">
      <h2>チェックポイント</h2>
      <ul>
        <li>iPhone Safariで「開始」をタップ → マイク許可 → 音名が追従する</li>
        <li>無音時は表示が「…」になり、confidenceが低下する</li>
        <li>ターゲット音を変えるとゲージ判定が切り替わる</li>
        <li>基準音ボタンでターゲット音が鳴る</li>
        <li>録音→停止→再生ができ、時系列が表示される</li>
      </ul>
    </section>
  </main>
`

const startButton = app.querySelector<HTMLButtonElement>('#startButton')
const retryButton = app.querySelector<HTMLButtonElement>('#retryButton')
const playToneButton = app.querySelector<HTMLButtonElement>('#playToneButton')
const playOctaveButton = app.querySelector<HTMLButtonElement>('#playOctaveButton')
const toneStatus = app.querySelector<HTMLParagraphElement>('#toneStatus')
const recordButton = app.querySelector<HTMLButtonElement>('#recordButton')
const playRecordButton = app.querySelector<HTMLButtonElement>('#playRecordButton')
const recordStatus = app.querySelector<HTMLDivElement>('#recordStatus')
const recordedAudio = app.querySelector<HTMLAudioElement>('#recordedAudio')
const statusPill = app.querySelector<HTMLSpanElement>('#statusPill')
const statusText = app.querySelector<HTMLParagraphElement>('#statusText')
const waveform = app.querySelector<HTMLPreElement>('#waveform')
const metrics = app.querySelector<HTMLDivElement>('.metrics')
const currentNote = app.querySelector<HTMLDivElement>('#currentNote')
const targetSelect = app.querySelector<HTMLSelectElement>('#targetSelect')
const freqValue = app.querySelector<HTMLDivElement>('#freqValue')
const centsValue = app.querySelector<HTMLDivElement>('#centsValue')
const confidenceValue = app.querySelector<HTMLDivElement>('#confidenceValue')
const gauge = app.querySelector<HTMLDivElement>('#gauge')
const gaugeNeedle = app.querySelector<HTMLDivElement>('#gaugeNeedle')
const gaugeLabel = app.querySelector<HTMLDivElement>('#gaugeLabel')
const reviewStats = app.querySelector<HTMLDivElement>('#reviewStats')
const reviewScore = app.querySelector<HTMLDivElement>('#reviewScore')
const reviewChallenge = app.querySelector<HTMLDivElement>('#reviewChallenge')
const playMelodyButton = app.querySelector<HTMLButtonElement>('#playMelodyButton')
const melodySpeedSelect = app.querySelector<HTMLSelectElement>('#melodySpeedSelect')
const reviewList = app.querySelector<HTMLPreElement>('#reviewList')
const reviewCanvas = app.querySelector<HTMLCanvasElement>('#reviewCanvas')

if (
  !startButton ||
  !retryButton ||
  !playToneButton ||
  !playOctaveButton ||
  !toneStatus ||
  !recordButton ||
  !playRecordButton ||
  !recordStatus ||
  !recordedAudio ||
  !statusPill ||
  !statusText ||
  !waveform ||
  !metrics ||
  !currentNote ||
  !targetSelect ||
  !freqValue ||
  !centsValue ||
  !confidenceValue ||
  !gauge ||
  !gaugeNeedle ||
  !gaugeLabel ||
  !reviewStats ||
  !reviewScore ||
  !reviewChallenge ||
  !playMelodyButton ||
  !melodySpeedSelect ||
  !reviewList ||
  !reviewCanvas
) {
  throw new Error('Required UI elements not found')
}

let audioContext: AudioContext | null = null
let analyser: AnalyserNode | null = null
let byteData: Uint8Array<ArrayBuffer> | null = null
let floatData: Float32Array<ArrayBuffer> | null = null
let animationId: number | null = null
let mediaStream: MediaStream | null = null
let isRunning = false
let smoothedFrequency: number | null = null
let lastConfidence = 0
let targetMidi = 60
let mediaRecorder: MediaRecorder | null = null
let recordedChunks: BlobPart[] = []
let recordedFrames: RecordedFrame[] = []
let recordStartTime = 0
let recordFrameCounter = 0
let isRecording = false
let recordObjectUrl: string | null = null
let soundfontModule: SoundfontModule | null = null
let pianoInstrument: SoundfontInstrument | null = null
let pianoPromise: Promise<SoundfontInstrument> | null = null
let isToneLoading = false
let activeNote: { stop: () => void } | null = null
let melodySequence: MelodyEvent[] = []
let isMelodyPlaying = false
let melodyNotes: Array<{ stop: () => void }> = []
let melodyStopTimer: number | null = null
let melodySpeed = 1

const setStatus = (state: StatusState, message: string) => {
  statusPill.dataset.state = state
  statusPill.textContent =
    state === 'success' ? 'LIVE' : state === 'error' ? 'ERROR' : state === 'working' ? 'WAIT' : 'READY'
  statusText.textContent = message
  retryButton.hidden = state !== 'error'
}

const setToneStatus = (state: ToneStatus, message: string) => {
  toneStatus.dataset.state = state
  toneStatus.textContent = message
}

const setStartButtonLabel = () => {
  startButton.textContent = isRunning ? '停止' : '開始'
}

const setRecordButtonLabel = () => {
  recordButton.textContent = isRecording ? '録音停止' : '録音開始'
  recordStatus.textContent = isRecording ? '録音中…' : '停止中'
}

const setMelodyButtonLabel = () => {
  playMelodyButton.textContent = isMelodyPlaying ? 'メロディ停止' : 'メロディ再生'
}

const setControls = (isWorking: boolean) => {
  startButton.disabled = isWorking
  retryButton.disabled = isWorking
  recordButton.disabled = isWorking

  const toneDisabled = isWorking || isToneLoading
  playToneButton.disabled = toneDisabled
  playOctaveButton.disabled = toneDisabled
  playMelodyButton.disabled = toneDisabled || melodySequence.length === 0
  melodySpeedSelect.disabled = toneDisabled || melodySequence.length === 0

  if (isWorking) {
    playRecordButton.disabled = true
  }
}

const stopStream = () => {
  if (animationId !== null) {
    cancelAnimationFrame(animationId)
    animationId = null
  }
  if (mediaStream) {
    mediaStream.getTracks().forEach((track) => track.stop())
    mediaStream = null
  }
  analyser = null
  byteData = null
  floatData = null
}

const stopReferenceTone = () => {
  if (activeNote) {
    try {
      activeNote.stop()
    } catch {
      // ignore if already stopped
    }
    activeNote = null
  }
  pianoInstrument?.stop()
}

const getAudioContextClass = (): AudioContextClass | undefined => {
  return window.AudioContext ?? (window as Window & { webkitAudioContext?: AudioContextClass }).webkitAudioContext
}

const ensureAudioContext = async () => {
  const AudioContextCtor = getAudioContextClass()
  if (!AudioContextCtor) {
    setStatus('error', 'このブラウザはAudioContextに未対応です。')
    return null
  }

  if (!audioContext || audioContext.state === 'closed') {
    audioContext = new AudioContextCtor()
  }

  if (audioContext.state === 'suspended') {
    await audioContext.resume()
  }

  return audioContext
}

const soundfontUrl = (name: string, soundfont: string, format: string) => {
  return `${SOUND_FONT_BASE_URL}${soundfont}/${name}-${format}.js`
}

const loadSoundfontModule = async () => {
  if (soundfontModule) return soundfontModule
  const imported = await import('soundfont-player')
  soundfontModule = (imported.default ?? imported) as SoundfontModule
  return soundfontModule
}

const loadPianoSoundfont = async () => {
  if (pianoInstrument) return pianoInstrument
  if (pianoPromise) return pianoPromise

  const context = await ensureAudioContext()
  if (!context) return null

  isToneLoading = true
  setToneStatus('loading', 'ピアノ音を読み込み中…')
  setControls(false)

  try {
    const soundfont = await loadSoundfontModule()
    pianoPromise = soundfont.instrument(context, SOUND_FONT_INSTRUMENT, {
      soundfont: SOUND_FONT_NAME,
      format: SOUND_FONT_FORMAT,
      notes: SOUND_FONT_NOTES,
      nameToUrl: soundfontUrl,
    })
    pianoInstrument = await pianoPromise
    setToneStatus('ready', 'ピアノ音の準備完了')
    return pianoInstrument
  } catch {
    pianoInstrument = null
    setToneStatus('error', 'ピアノ音の読み込みに失敗しました')
    return null
  } finally {
    pianoPromise = null
    isToneLoading = false
    setControls(false)
  }
}

const hzToMidi = (frequency: number) => 69 + 12 * Math.log2(frequency / 440)

const midiToFrequency = (midi: number) => 440 * Math.pow(2, (midi - 69) / 12)

const midiToNote = (midi: number) => {
  const rounded = Math.round(midi)
  const name = NOTE_NAMES[(rounded % 12 + 12) % 12]
  const octave = Math.floor(rounded / 12) - 1
  return `${name}${octave}`
}

const midiToSolfege = (midi: number) => {
  const rounded = Math.round(midi)
  const name = SOLFEGE_NAMES[(rounded % 12 + 12) % 12]
  return name
}

const midiToSoundfontNote = (midi: number) => {
  return midiToNote(midi).replace('#', 's')
}

const autoCorrelate = (buffer: Float32Array, sampleRate: number): PitchResult => {
  const size = buffer.length
  let mean = 0
  for (let i = 0; i < size; i += 1) {
    mean += buffer[i]
  }
  mean /= size

  let variance = 0
  for (let i = 0; i < size; i += 1) {
    const value = buffer[i] - mean
    variance += value * value
  }

  if (variance < 1e-7) {
    return { frequency: null, confidence: 0 }
  }

  const minLag = Math.max(1, Math.floor(sampleRate / MAX_FREQUENCY))
  const maxLag = Math.min(size - 1, Math.floor(sampleRate / MIN_FREQUENCY))

  let bestLag = -1
  let bestCorrelation = 0

  for (let lag = minLag; lag <= maxLag; lag += 1) {
    let correlation = 0
    for (let i = 0; i < size - lag; i += 1) {
      const a = buffer[i] - mean
      const b = buffer[i + lag] - mean
      correlation += a * b
    }

    if (correlation > bestCorrelation) {
      bestCorrelation = correlation
      bestLag = lag
    }
  }

  const confidence = Math.min(Math.max(bestCorrelation / variance, 0), 1)

  if (bestLag <= 0) {
    return { frequency: null, confidence }
  }

  return { frequency: sampleRate / bestLag, confidence }
}

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value))

const average = (values: number[]) => {
  if (values.length === 0) return null
  return values.reduce((sum, value) => sum + value, 0) / values.length
}

const standardDeviation = (values: number[]) => {
  const mean = average(values)
  if (mean === null) return null
  const variance = values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / values.length
  return Math.sqrt(variance)
}

const analyzeVibrato = (frames: RecordedFrame[]) => {
  if (frames.length < 10) return null
  const centsSeries = frames.map((frame) => frame.cents).filter((value): value is number => value !== null)
  if (centsSeries.length < 10) return null

  const mean = average(centsSeries) ?? 0
  let crossings = 0
  let prevSign = 0

  for (const value of centsSeries) {
    const centered = value - mean
    if (Math.abs(centered) < 2) continue
    const sign = centered > 0 ? 1 : -1
    if (prevSign !== 0 && sign !== prevSign) {
      crossings += 1
    }
    prevSign = sign
  }

  const duration = frames[frames.length - 1].t - frames[0].t
  if (duration <= 0) return null

  const rate = crossings / (2 * duration)
  const depth = standardDeviation(centsSeries) ?? 0
  const hasVibrato = rate >= 3 && rate <= 8 && depth >= 6 && crossings >= 4

  return { rate, depth, hasVibrato }
}

const buildMelodySequence = (frames: RecordedFrame[], stepSeconds: number) => {
  if (frames.length === 0) return []
  const sorted = [...frames].sort((a, b) => a.t - b.t)
  const duration = sorted[sorted.length - 1].t
  if (duration <= 0) return []

  const events: MelodyEvent[] = []
  let index = 0

  for (let t = 0; t <= duration; t += stepSeconds) {
    const bucketEnd = t + stepSeconds
    const bucket: RecordedFrame[] = []

    while (index < sorted.length && sorted[index].t < bucketEnd) {
      bucket.push(sorted[index])
      index += 1
    }

    const valid = bucket.filter((frame) => frame.frequency !== null && frame.confidence >= MIN_CONFIDENCE)
    let midi: number | null = null

    if (valid.length > 0) {
      const avgFrequency = valid.reduce((sum, frame) => sum + (frame.frequency ?? 0), 0) / valid.length
      midi = Math.round(hzToMidi(avgFrequency))
    }

    events.push({ midi, duration: stepSeconds })
  }

  const compressed: MelodyEvent[] = []
  for (const event of events) {
    const last = compressed[compressed.length - 1]
    if (last && last.midi === event.midi) {
      last.duration += event.duration
    } else {
      compressed.push({ ...event })
    }
  }

  return compressed
}

const derivePitchMetrics = (frequency: number | null, confidence: number): PitchMetrics | null => {
  if (frequency === null || confidence < MIN_CONFIDENCE) {
    return null
  }

  const midi = hzToMidi(frequency)
  const targetFrequency = midiToFrequency(targetMidi)
  const centsFromTarget = 1200 * Math.log2(frequency / targetFrequency)

  return {
    frequency,
    confidence,
    note: midiToNote(midi),
    centsFromTarget,
  }
}

const updateGauge = (cents: number | null, confidence: number) => {
  if (cents === null || confidence < MIN_CONFIDENCE) {
    gauge.dataset.level = 'off'
    gaugeNeedle.style.left = '50%'
    gaugeLabel.textContent = 'NO SIGNAL'
    return
  }

  const abs = Math.abs(cents)
  let level: GaugeLevel = 'bad'
  if (abs <= 10) {
    level = 'good'
  } else if (abs <= 25) {
    level = 'ok'
  }

  gauge.dataset.level = level
  const clamped = Math.max(-MAX_GAUGE_CENTS, Math.min(MAX_GAUGE_CENTS, cents))
  const percent = 50 + (clamped / MAX_GAUGE_CENTS) * 50
  gaugeNeedle.style.left = `${percent}%`
  gaugeLabel.textContent = `${cents >= 0 ? '+' : ''}${cents.toFixed(1)}¢ ${level.toUpperCase()}`
}

const updatePitchDisplay = (metricsData: PitchMetrics | null, confidence: number) => {
  const isReliable = metricsData !== null
  metrics.dataset.low = isReliable ? 'false' : 'true'

  if (!isReliable) {
    currentNote.textContent = '…'
    freqValue.textContent = '…'
    centsValue.textContent = '…'
    updateGauge(null, confidence)
  } else {
    const midi = hzToMidi(metricsData.frequency)
    currentNote.innerHTML = `<span class="current-note-main">${midiToNote(midi)}</span><span class="current-note-sub">${midiToSolfege(
      midi,
    )}</span>`
    freqValue.textContent = `${metricsData.frequency.toFixed(2)} Hz`
    centsValue.textContent = `${metricsData.centsFromTarget >= 0 ? '+' : ''}${metricsData.centsFromTarget.toFixed(1)}¢`
    updateGauge(metricsData.centsFromTarget, confidence)
  }

  confidenceValue.textContent = `${Math.round(confidence * 100)}%`
}

const recordFrame = (metricsData: PitchMetrics | null, confidence: number) => {
  if (!isRecording) return
  recordFrameCounter += 1
  if (recordFrameCounter % RECORD_SAMPLE_EVERY !== 0) return

  const now = performance.now()
  const t = (now - recordStartTime) / 1000

  recordedFrames.push({
    t,
    frequency: metricsData?.frequency ?? null,
    confidence,
    cents: metricsData?.centsFromTarget ?? null,
    note: metricsData?.note ?? null,
  })
}

const renderWaveform = () => {
  if (!analyser || !byteData || !floatData) return

  analyser.getByteTimeDomainData(byteData)
  const preview = Array.from(byteData.slice(0, 48))
    .map((value) => String(value).padStart(3, ' '))
    .join(' ')
  waveform.textContent = preview

  if (typeof analyser.getFloatTimeDomainData === 'function') {
    analyser.getFloatTimeDomainData(floatData)
  } else {
    for (let i = 0; i < byteData.length; i += 1) {
      floatData[i] = (byteData[i] - 128) / 128
    }
  }

  const { frequency, confidence } = autoCorrelate(floatData, audioContext?.sampleRate ?? 44100)
  lastConfidence = confidence

  if (frequency !== null && confidence >= MIN_CONFIDENCE) {
    smoothedFrequency = smoothedFrequency === null ? frequency : smoothedFrequency + SMOOTHING * (frequency - smoothedFrequency)
  }

  const metricsData = derivePitchMetrics(smoothedFrequency, confidence)
  updatePitchDisplay(metricsData, confidence)
  recordFrame(metricsData, confidence)

  animationId = requestAnimationFrame(renderWaveform)
}

const renderReview = () => {
  if (recordedFrames.length === 0) {
    reviewStats.textContent = '-'
    reviewScore.textContent = '-'
    reviewChallenge.textContent = '-'
    reviewList.textContent = '-'
    melodySequence = []
    playMelodyButton.disabled = true
    melodySpeedSelect.disabled = true
    if (isMelodyPlaying) {
      stopMelodyPlayback()
    }
    const ctx = reviewCanvas.getContext('2d')
    if (ctx) {
      ctx.clearRect(0, 0, reviewCanvas.width, reviewCanvas.height)
    }
    return
  }

  const valid = recordedFrames.filter((frame) => frame.cents !== null)
  const avgAbsCents =
    valid.length > 0 ? valid.reduce((sum, frame) => sum + Math.abs(frame.cents ?? 0), 0) / valid.length : null
  const centsSeries = valid.map((frame) => frame.cents ?? 0)
  const centsStdDev = centsSeries.length > 0 ? standardDeviation(centsSeries) : null
  const stabilityScore =
    centsStdDev === null ? null : Math.round(clamp(100 - (centsStdDev / 25) * 100, 0, 100))
  const vibrato = analyzeVibrato(valid)
  const avgConfidence = recordedFrames.reduce((sum, frame) => sum + frame.confidence, 0) / recordedFrames.length

  reviewStats.textContent = `平均|cents|: ${avgAbsCents ? avgAbsCents.toFixed(1) + '¢' : '--'} / 平均confidence: ${Math.round(
    avgConfidence * 100,
  )}% / 有効サンプル: ${valid.length}/${recordedFrames.length}`

  const vibratoLabel = vibrato
    ? `揺れ周期: ${vibrato.rate.toFixed(1)}Hz / 幅: ${vibrato.depth.toFixed(1)}¢ / ${
        vibrato.hasVibrato ? '検出OK' : '弱め'
      }`
    : 'ビブラート: --'

  reviewScore.textContent = `安定度: ${stabilityScore ?? '--'} / 100\n${vibratoLabel}`

  let challenge = '録音結果は良好です。ターゲット音を変えて練習しましょう。'
  if (valid.length < 10) {
    challenge = '有効なデータが少ないので、もう一度録音してみましょう。'
  } else if (avgConfidence < 0.3) {
    challenge = '入力が不安定です。マイク距離や声量を調整しましょう。'
  } else if (stabilityScore !== null && stabilityScore < 60) {
    challenge = '安定度が低めです。ロングトーンで揺れを抑える練習を。'
  } else if (vibrato && !vibrato.hasVibrato) {
    challenge = 'ビブラートが弱めです。息の流れを一定にして揺れを意識。'
  } else if (vibrato && vibrato.rate < 3) {
    challenge = 'ビブラートがゆっくりです。テンポを少し上げましょう。'
  } else if (vibrato && vibrato.rate > 8) {
    challenge = 'ビブラートが速めです。テンポを少し落ち着かせましょう。'
  }
  reviewChallenge.textContent = challenge

  melodySequence = buildMelodySequence(recordedFrames, MELODY_STEP_SECONDS)
  const hasMelody = melodySequence.some((event) => event.midi !== null)
  playMelodyButton.disabled = isToneLoading || !hasMelody
  melodySpeedSelect.disabled = isToneLoading || !hasMelody
  if (!hasMelody && isMelodyPlaying) {
    stopMelodyPlayback()
  }

  const step = Math.max(1, Math.ceil(recordedFrames.length / MAX_REVIEW_LINES))
  const lines: string[] = []
  for (let i = 0; i < recordedFrames.length; i += step) {
    const frame = recordedFrames[i]
    const note = frame.note ?? '…'
    const freq = frame.frequency !== null ? `${frame.frequency.toFixed(1)}Hz` : '…'
    const cents = frame.cents !== null ? `${frame.cents >= 0 ? '+' : ''}${frame.cents.toFixed(1)}¢` : '…'
    const conf = `${Math.round(frame.confidence * 100)}%`
    lines.push(`${frame.t.toFixed(2)}s  ${note}  ${freq}  ${cents}  ${conf}`)
  }
  reviewList.textContent = lines.join('\n')

  const ctx = reviewCanvas.getContext('2d')
  if (!ctx) return

  const rect = reviewCanvas.getBoundingClientRect()
  const ratio = window.devicePixelRatio || 1
  reviewCanvas.width = Math.max(1, Math.floor(rect.width * ratio))
  reviewCanvas.height = Math.max(1, Math.floor(rect.height * ratio))
  ctx.scale(ratio, ratio)

  ctx.clearRect(0, 0, rect.width, rect.height)
  ctx.fillStyle = '#fffaf4'
  ctx.fillRect(0, 0, rect.width, rect.height)

  ctx.strokeStyle = '#e6d6c7'
  ctx.lineWidth = 1
  ctx.beginPath()
  ctx.moveTo(0, rect.height / 2)
  ctx.lineTo(rect.width, rect.height / 2)
  ctx.stroke()

  const duration = recordedFrames[recordedFrames.length - 1].t || 1
  ctx.strokeStyle = '#d96c4a'
  ctx.lineWidth = 2
  ctx.beginPath()
  let started = false

  for (const frame of recordedFrames) {
    if (frame.cents === null) {
      started = false
      continue
    }
    const x = (frame.t / duration) * rect.width
    const clamped = Math.max(-MAX_GAUGE_CENTS, Math.min(MAX_GAUGE_CENTS, frame.cents))
    const y = rect.height / 2 - (clamped / MAX_GAUGE_CENTS) * (rect.height * 0.4)
    if (!started) {
      ctx.moveTo(x, y)
      started = true
    } else {
      ctx.lineTo(x, y)
    }
  }
  ctx.stroke()
}

const handleError = (error: unknown) => {
  const message =
    error instanceof DOMException
      ? error.name === 'NotAllowedError'
        ? 'マイク権限が拒否されました。ブラウザ設定で許可してください。'
        : error.name === 'NotFoundError'
          ? '利用可能なマイクが見つかりません。'
          : `マイク取得に失敗しました: ${error.message}`
      : 'マイク取得に失敗しました。'

  isRunning = false
  setStartButtonLabel()
  setStatus('error', message)
  setControls(false)
}

const initAudio = async () => {
  if (!navigator.mediaDevices?.getUserMedia) {
    setStatus('error', 'このブラウザはgetUserMediaに未対応です。')
    return false
  }

  setStatus('working', 'マイク許可を待っています…')
  setControls(true)
  stopStream()
  smoothedFrequency = null

  try {
    const context = await ensureAudioContext()
    if (!context) {
      setControls(false)
      return false
    }

    mediaStream = await navigator.mediaDevices.getUserMedia({ audio: true })
    const source = context.createMediaStreamSource(mediaStream)
    analyser = context.createAnalyser()
    analyser.fftSize = 2048
    analyser.smoothingTimeConstant = 0.85

    source.connect(analyser)
    byteData = new Uint8Array(analyser.fftSize)
    floatData = new Float32Array(analyser.fftSize)
    renderWaveform()

    isRunning = true
    setStartButtonLabel()
    setStatus('success', 'マイク入力を取得しました。ピッチ解析中です。')
    setControls(false)

    if (!pianoInstrument && !pianoPromise) {
      void loadPianoSoundfont()
    }

    return true
  } catch (error) {
    handleError(error)
    return false
  }
}

const stopAudio = () => {
  if (isRecording) {
    stopRecording()
  }
  stopStream()
  stopReferenceTone()
  stopMelodyPlayback()
  isRunning = false
  smoothedFrequency = null
  updatePitchDisplay(null, 0)
  waveform.textContent = '-'
  setStartButtonLabel()
  setStatus('idle', '停止しました。開始ボタンを押してください。')
  setControls(false)
}

const buildTargetOptions = () => {
  const fragment = document.createDocumentFragment()
  for (let midi = TARGET_START_MIDI; midi <= TARGET_END_MIDI; midi += 1) {
    const option = document.createElement('option')
    option.value = String(midi)
    option.textContent = `${midiToNote(midi)} (${midiToSolfege(midi)})`
    fragment.appendChild(option)
  }
  targetSelect.appendChild(fragment)
}

const playReferenceTone = async (octaveShift: number) => {
  const instrument = await loadPianoSoundfont()
  if (!instrument) return

  const context = await ensureAudioContext()
  if (!context) return

  stopReferenceTone()

  const midi = targetMidi + octaveShift
  activeNote = instrument.play(midiToSoundfontNote(midi), context.currentTime, {
    duration: 1.2,
    gain: 0.9,
  })
}

const stopMelodyPlayback = () => {
  if (melodyStopTimer !== null) {
    window.clearTimeout(melodyStopTimer)
    melodyStopTimer = null
  }
  melodyNotes.forEach((note) => {
    try {
      note.stop()
    } catch {
      // ignore
    }
  })
  melodyNotes = []
  isMelodyPlaying = false
  setMelodyButtonLabel()
}

const playMelody = async () => {
  if (isMelodyPlaying) {
    stopMelodyPlayback()
    return
  }

  if (melodySequence.length === 0) return

  const instrument = await loadPianoSoundfont()
  if (!instrument) return

  const context = await ensureAudioContext()
  if (!context) return

  stopReferenceTone()
  stopMelodyPlayback()

  isMelodyPlaying = true
  setMelodyButtonLabel()

  let time = context.currentTime + 0.05
  let totalDuration = 0
  const speed = melodySpeed > 0 ? melodySpeed : 1

  for (const event of melodySequence) {
    const duration = event.duration / speed
    if (event.midi !== null) {
      melodyNotes.push(
        instrument.play(midiToSoundfontNote(event.midi), time, {
          duration,
          gain: 0.9,
        }),
      )
    }
    time += duration
    totalDuration += duration
  }

  melodyStopTimer = window.setTimeout(() => {
    stopMelodyPlayback()
  }, totalDuration * 1000 + 120)
}

const getSupportedMimeType = () => {
  if (typeof MediaRecorder === 'undefined') return null
  const candidates = ['audio/mp4', 'audio/webm;codecs=opus', 'audio/webm']
  for (const type of candidates) {
    if (MediaRecorder.isTypeSupported(type)) {
      return type
    }
  }
  return null
}

const startRecording = async () => {
  if (isRecording) return
  if (isMelodyPlaying) {
    stopMelodyPlayback()
  }

  if (!isRunning) {
    const started = await initAudio()
    if (!started) return
  }

  if (!mediaStream) {
    setStatus('error', 'マイク入力が取得できていません。')
    return
  }

  if (typeof MediaRecorder === 'undefined') {
    setStatus('error', 'このブラウザはMediaRecorderに未対応です。')
    return
  }

  recordedChunks = []
  recordedFrames = []
  recordStartTime = performance.now()
  recordFrameCounter = 0

  const mimeType = getSupportedMimeType()
  try {
    mediaRecorder = new MediaRecorder(mediaStream, mimeType ? { mimeType } : undefined)
  } catch {
    mediaRecorder = new MediaRecorder(mediaStream)
  }

  mediaRecorder.ondataavailable = (event) => {
    if (event.data.size > 0) {
      recordedChunks.push(event.data)
    }
  }

  mediaRecorder.onstop = () => {
    const blob = new Blob(recordedChunks, { type: mediaRecorder?.mimeType || 'audio/webm' })
    if (recordObjectUrl) {
      URL.revokeObjectURL(recordObjectUrl)
    }
    recordObjectUrl = URL.createObjectURL(blob)
    recordedAudio.src = recordObjectUrl
    recordedAudio.hidden = false
    playRecordButton.disabled = false
    renderReview()
  }

  mediaRecorder.start()
  isRecording = true
  setRecordButtonLabel()
  playRecordButton.disabled = true
}

const stopRecording = () => {
  if (!isRecording) return
  if (mediaRecorder && mediaRecorder.state !== 'inactive') {
    mediaRecorder.stop()
  }
  isRecording = false
  setRecordButtonLabel()
}

buildTargetOptions()
targetSelect.value = String(targetMidi)
setStartButtonLabel()
setRecordButtonLabel()
setMelodyButtonLabel()
setToneStatus('idle', 'ピアノ音は未読み込み')
playMelodyButton.disabled = true
melodySpeedSelect.disabled = true

startButton.addEventListener('click', () => {
  if (isRunning) {
    stopAudio()
    return
  }
  void initAudio()
})

retryButton.addEventListener('click', () => {
  void initAudio()
})

playToneButton.addEventListener('click', () => {
  void playReferenceTone(0)
})

playOctaveButton.addEventListener('click', () => {
  void playReferenceTone(-12)
})

playMelodyButton.addEventListener('click', () => {
  void playMelody()
})

melodySpeedSelect.addEventListener('change', () => {
  const value = Number(melodySpeedSelect.value)
  if (!Number.isNaN(value) && value > 0) {
    melodySpeed = value
  }
  if (isMelodyPlaying) {
    stopMelodyPlayback()
  }
})

recordButton.addEventListener('click', () => {
  if (isRecording) {
    stopRecording()
    return
  }
  void startRecording()
})

playRecordButton.addEventListener('click', () => {
  void recordedAudio.play()
})

targetSelect.addEventListener('change', () => {
  const value = Number(targetSelect.value)
  if (!Number.isNaN(value)) {
    targetMidi = value
    const metricsData = derivePitchMetrics(smoothedFrequency, lastConfidence)
    updatePitchDisplay(metricsData, lastConfidence)
  }
})
