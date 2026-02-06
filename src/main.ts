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
  midi: number
  note: string
  centsFromTarget: number
}

type RecordedFrame = {
  t: number
  frequency: number | null
  midi: number | null
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
type DisplayMode = 'single' | 'karaoke'
type KaraokeEvent = {
  midi: number
  start: number
  duration: number
}
type KaraokeSegment = {
  midi: number
  start: number
  end: number
}
type PlaybackMode = 'record' | 'piano'

const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B']
const SOLFEGE_NAMES = ['ド', 'ド#', 'レ', 'レ#', 'ミ', 'ファ', 'ファ#', 'ソ', 'ソ#', 'ラ', 'ラ#', 'シ']

const MIN_FREQUENCY = 55
const MAX_FREQUENCY = 1000
const MIN_CONFIDENCE = 0.18
const MIN_RMS = 0.01
const SMOOTHING = 0.18
const STABILITY_WINDOW = 7
const STABILITY_HOLD_FRAMES = 4
const STABILITY_SILENCE_FRAMES = 10
const STABILITY_HANGOVER_FRAMES = 6
const TARGET_START_MIDI = 48
const TARGET_END_MIDI = 83
const MAX_GAUGE_CENTS = 50
const RECORD_SAMPLE_EVERY = 4
const MAX_REVIEW_LINES = 140
const MELODY_STEP_SECONDS = 0.1
const KARAOKE_RANGE_PADDING = 3
const KARAOKE_MIN_RANGE = 8
const KARAOKE_TRAIL_SECONDS = 1.2
const KARAOKE_GAP_TOLERANCE = 0.22
const KARAOKE_MIDI_TOLERANCE = 1
const KARAOKE_MIN_SEGMENT_SECONDS = 0.1
const KARAOKE_HOLD_SECONDS = 0.12
const KARAOKE_MIN_BAR_WIDTH = 14
const LANE_PADDING = 12
const LANE_TOP_PADDING = 12
const LANE_BOTTOM_PADDING = 12
const LANE_BAR_HEIGHT = 14
const REFERENCE_SAMPLE_AMPLITUDE = 0.75
const MELODY_SAMPLE_AMPLITUDE = 0.525
const OSC_REFERENCE_GAIN = 0.42
const OSC_MELODY_GAIN = 0.33
const PIANO_REFERENCE_GAIN = 1.8
const PIANO_MELODY_GAIN = 1.65

const SOUND_FONT_BASE_URL = 'https://gleitz.github.io/midi-js-soundfonts/'
const SOUND_FONT_NAME = 'FluidR3_GM'
const SOUND_FONT_FORMAT = 'mp3'
const SOUND_FONT_INSTRUMENT = 'acoustic_grand_piano'
const SOUND_FONT_NOTE_START = Math.max(0, TARGET_START_MIDI - 12)
const SOUND_FONT_NOTE_END = TARGET_END_MIDI
const SOUND_FONT_NOTES = Array.from(
  { length: SOUND_FONT_NOTE_END - SOUND_FONT_NOTE_START + 1 },
  (_, index) => {
    const midi = SOUND_FONT_NOTE_START + index
    const name = NOTE_NAMES[(midi % 12 + 12) % 12]
    const octave = Math.floor(midi / 12) - 1
    return `${name}${octave}`.replace('#', 's')
  },
)
const IS_IOS = /iP(hone|od|ad)/.test(navigator.userAgent)
const IS_ANDROID = /Android/.test(navigator.userAgent)
const IS_MOBILE = IS_IOS || IS_ANDROID
const PREFER_MEDIA_TONE = IS_MOBILE
const TONE_SAMPLE_RATE = 22050

const app = document.querySelector<HTMLDivElement>('#app')
if (!app) {
  throw new Error('App root element not found')
}

app.innerHTML = `
  <main class="pp-app" data-mode="single" data-recording="false" data-playing="false">
    <div class="pp-bg">
      <span class="pp-blob blob-1"></span>
      <span class="pp-blob blob-2"></span>
    </div>

    <section class="pp-phone">
      <header class="pp-header">
        <h1 class="pp-title">PerfectPitch</h1>
        <div class="pp-toggle" role="tablist">
          <button id="modeSingle" class="pp-toggle-btn is-active" type="button">単音</button>
          <button id="modeKaraoke" class="pp-toggle-btn" type="button">カラオケ</button>
        </div>
      </header>

      <div class="pp-status">
        <div class="pp-status-row">
          <div id="recordPill" class="pp-pill pp-pill-record" data-active="false">
            <span class="pp-dot"></span>
            <span id="recordStatus">停止中</span>
          </div>
          <div id="playPill" class="pp-pill pp-pill-play" data-active="false">
            <span class="pp-dot"></span>
            <span id="playStatusText">再生中</span>
          </div>
          <button id="startButton" class="pp-pill pp-pill-action" type="button">開始</button>
          <button id="retryButton" class="pp-pill pp-pill-ghost" type="button" hidden>再試行</button>
        </div>
        <div class="pp-system">
          <span id="statusPill" class="pp-system-pill" data-state="idle">READY</span>
          <span id="statusText" class="pp-system-text">開始ボタンを押してください。</span>
        </div>
      </div>

      <section class="pp-card pitch-card">
        <div class="pp-card-top">
          <span class="pp-card-label">現在の音程</span>
          <label class="pp-chip tune-chip">
            <select id="targetSelect" class="tune-select" aria-label="ターゲット音"></select>
          </label>
        </div>
        <div id="currentNote" class="pp-note">…</div>
        <div id="metrics" class="pp-metrics" data-low="true">
          <div class="pp-freq-row">
            <span id="freqValue" class="pp-freq">…</span>
            <span id="centsValue" class="pp-cents">…</span>
          </div>
          <span id="confidenceValue" class="pp-confidence">--%</span>
        </div>
        <div id="gauge" class="pp-pitch-bar" data-level="off">
          <span class="pp-bar-tick tick-1"></span>
          <span class="pp-bar-tick tick-2"></span>
          <span class="pp-bar-tick tick-3"></span>
          <span class="pp-bar-tick tick-4"></span>
          <span class="pp-bar-center"></span>
          <span id="gaugeNeedle" class="pp-bar-indicator"></span>
          <span id="gaugeLabel" class="pp-bar-label">NO SIGNAL</span>
        </div>
      </section>

      <section class="pp-card bar-card">
        <div class="pp-card-top">
          <span id="barLabel" class="pp-card-label">バー表示</span>
          <span id="barStatus" class="pp-pill pp-pill-inline" data-state="rec">録音中</span>
          <span id="barChip" class="pp-chip">カラオケ</span>
        </div>
        <div class="pp-lane">
          <span class="pp-lane-line line-1"></span>
          <span class="pp-lane-line line-2"></span>
          <span class="pp-lane-line line-3"></span>
          <span class="pp-lane-target t1"></span>
          <span class="pp-lane-target t2"></span>
          <span class="pp-lane-target t3"></span>
          <span class="pp-lane-target t4"></span>
          <span class="pp-lane-trail tr1"></span>
          <span class="pp-lane-trail tr2"></span>
          <span class="pp-lane-trail tr3"></span>
          <span class="pp-lane-current"></span>
          <span class="pp-lane-dot"></span>
        </div>
        <div class="pp-current-row">
          <span id="laneCurrentText" class="pp-current-text">現在: --</span>
          <span id="laneCentsText" class="pp-cents-chip">--</span>
        </div>
      </section>

      <section class="pp-card session-card">
        <div class="pp-section live-section">
          <span class="pp-card-label">リアルタイム音階</span>
          <div class="pp-chip-row">
            <span class="pp-chip muted">A3</span>
            <span class="pp-chip muted">B3</span>
            <span class="pp-chip muted">C4</span>
            <span class="pp-chip active">C#4</span>
            <span class="pp-chip muted">D4</span>
          </div>
        </div>
        <div class="pp-section">
          <span class="pp-card-label">再生モード</span>
          <div class="pp-segment">
            <button id="playbackRecord" class="pp-seg" type="button">録音そのまま</button>
            <button id="playbackPiano" class="pp-seg is-active" type="button">ピアノ音</button>
          </div>
        </div>
        <div class="pp-controls">
          <button id="playMelodyButton" class="pp-btn pp-btn-play" type="button" disabled>再生</button>
          <button id="recordButton" class="pp-btn pp-btn-rec" type="button">録音</button>
        </div>
        <div class="pp-subcontrols">
          <button id="playRecordButton" class="pp-btn pp-btn-sub" type="button" disabled>録音再生</button>
          <label class="pp-speed">
            <span>再生速度</span>
            <select id="melodySpeedSelect" class="pp-speed-select" aria-label="メロディ再生速度">
              <option value="0.5">0.5x</option>
              <option value="0.75">0.75x</option>
              <option value="1" selected>1x</option>
              <option value="1.25">1.25x</option>
              <option value="1.5">1.5x</option>
            </select>
          </label>
        </div>
        <div class="pp-tone-actions">
          <button id="playToneButton" class="pp-btn pp-btn-ghost" type="button">基準音を鳴らす</button>
          <button id="playOctaveButton" class="pp-btn pp-btn-ghost" type="button">1オク下を鳴らす</button>
        </div>
        <p id="toneStatus" class="pp-tone-status" data-state="idle">ピアノ音は未読み込み</p>
        <audio id="recordedAudio" class="recorded-audio" controls hidden></audio>
      </section>
    </section>
  </main>
`

const appRoot = app.querySelector<HTMLElement>('.pp-app')
const modeSingle = app.querySelector<HTMLButtonElement>('#modeSingle')
const modeKaraoke = app.querySelector<HTMLButtonElement>('#modeKaraoke')
const recordPill = app.querySelector<HTMLDivElement>('#recordPill')
const playPill = app.querySelector<HTMLDivElement>('#playPill')
const playStatusText = app.querySelector<HTMLSpanElement>('#playStatusText')
const barLabel = app.querySelector<HTMLSpanElement>('#barLabel')
const barStatus = app.querySelector<HTMLSpanElement>('#barStatus')
const barChip = app.querySelector<HTMLSpanElement>('#barChip')
const laneCurrentText = app.querySelector<HTMLSpanElement>('#laneCurrentText')
const laneCentsText = app.querySelector<HTMLSpanElement>('#laneCentsText')
const lane = app.querySelector<HTMLDivElement>('.pp-lane')
const laneDot = app.querySelector<HTMLSpanElement>('.pp-lane-dot')
const laneTargets = Array.from(app.querySelectorAll<HTMLSpanElement>('.pp-lane-target'))
const laneTrails = Array.from(app.querySelectorAll<HTMLSpanElement>('.pp-lane-trail'))
const startButton = app.querySelector<HTMLButtonElement>('#startButton')
const retryButton = app.querySelector<HTMLButtonElement>('#retryButton')
const playToneButton = app.querySelector<HTMLButtonElement>('#playToneButton')
const playOctaveButton = app.querySelector<HTMLButtonElement>('#playOctaveButton')
const toneStatus = app.querySelector<HTMLParagraphElement>('#toneStatus')
const playbackRecordButton = app.querySelector<HTMLButtonElement>('#playbackRecord')
const playbackPianoButton = app.querySelector<HTMLButtonElement>('#playbackPiano')
const recordButton = app.querySelector<HTMLButtonElement>('#recordButton')
const playRecordButton = app.querySelector<HTMLButtonElement>('#playRecordButton')
const recordStatus = app.querySelector<HTMLSpanElement>('#recordStatus')
const recordedAudio = app.querySelector<HTMLAudioElement>('#recordedAudio')
const statusPill = app.querySelector<HTMLSpanElement>('#statusPill')
const statusText = app.querySelector<HTMLSpanElement>('#statusText')
const waveform = app.querySelector<HTMLPreElement>('#waveform')
const metrics = app.querySelector<HTMLDivElement>('#metrics')
const currentNote = app.querySelector<HTMLDivElement>('#currentNote')
const targetSelect = app.querySelector<HTMLSelectElement>('#targetSelect')
const freqValue = app.querySelector<HTMLSpanElement>('#freqValue')
const centsValue = app.querySelector<HTMLSpanElement>('#centsValue')
const confidenceValue = app.querySelector<HTMLSpanElement>('#confidenceValue')
const gauge = app.querySelector<HTMLDivElement>('#gauge')
const gaugeNeedle = app.querySelector<HTMLSpanElement>('#gaugeNeedle')
const gaugeLabel = app.querySelector<HTMLSpanElement>('#gaugeLabel')
const reviewStats = app.querySelector<HTMLDivElement>('#reviewStats')
const reviewScore = app.querySelector<HTMLDivElement>('#reviewScore')
const reviewChallenge = app.querySelector<HTMLDivElement>('#reviewChallenge')
const playMelodyButton = app.querySelector<HTMLButtonElement>('#playMelodyButton')
const melodySpeedSelect = app.querySelector<HTMLSelectElement>('#melodySpeedSelect')
const reviewList = app.querySelector<HTMLPreElement>('#reviewList')
const reviewCanvas = app.querySelector<HTMLCanvasElement>('#reviewCanvas')

if (
  !appRoot ||
  !modeSingle ||
  !modeKaraoke ||
  !recordPill ||
  !playPill ||
  !playStatusText ||
  !barLabel ||
  !barStatus ||
  !barChip ||
  !laneCurrentText ||
  !laneCentsText ||
  !lane ||
  !laneDot ||
  laneTargets.length === 0 ||
  laneTrails.length === 0 ||
  !startButton ||
  !retryButton ||
  !playToneButton ||
  !playOctaveButton ||
  !toneStatus ||
  !playbackRecordButton ||
  !playbackPianoButton ||
  !recordButton ||
  !playRecordButton ||
  !recordStatus ||
  !recordedAudio ||
  !statusPill ||
  !statusText ||
  !metrics ||
  !currentNote ||
  !targetSelect ||
  !freqValue ||
  !centsValue ||
  !confidenceValue ||
  !gauge ||
  !gaugeNeedle ||
  !gaugeLabel ||
  !playMelodyButton ||
  !melodySpeedSelect
) {
  throw new Error('Required UI elements not found')
}

let audioContext: AudioContext | null = null
let playbackContext: AudioContext | null = null
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
let karaokeEvents: KaraokeEvent[] = []
let karaokeSegments: KaraokeSegment[] = []
let karaokeStartAt = 0
let karaokeAnimationId: number | null = null
let currentMode: DisplayMode = 'single'
let playbackMode: PlaybackMode = 'piano'
let isRecordPlaying = false
let hasAudioUnlocked = false
let toneAudio: HTMLAudioElement | null = null
let toneObjectUrl: string | null = null
let forceMediaTone = false
let frequencyWindow: number[] = []
let candidateMidi: number | null = null
let candidateFrames = 0
let stableMidi: number | null = null
let silenceFrames = 0
let lastStableMetrics: PitchMetrics | null = null
let hasRecordedAudio = false

const formatError = (error: unknown) => {
  if (error instanceof DOMException) {
    return `${error.name}${error.message ? `: ${error.message}` : ''}`
  }
  if (error instanceof Error) {
    return error.message
  }
  if (typeof error === 'string') {
    return error
  }
  return null
}

const shouldUseMediaTone = () => {
  if (forceMediaTone || PREFER_MEDIA_TONE) return true
  return !getAudioContextClass()
}

const getToneAudio = () => {
  if (!toneAudio) {
    toneAudio = new Audio()
    toneAudio.preload = 'auto'
    toneAudio.volume = 1
    toneAudio.setAttribute('playsinline', '')
  }
  return toneAudio
}

const stopToneAudio = () => {
  if (!toneAudio) return
  toneAudio.onended = null
  toneAudio.pause()
  try {
    toneAudio.currentTime = 0
  } catch {
    // ignore seek errors
  }
  if (toneObjectUrl) {
    URL.revokeObjectURL(toneObjectUrl)
    toneObjectUrl = null
  }
}

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

const setMode = (mode: DisplayMode) => {
  currentMode = mode
  appRoot.dataset.mode = mode
  modeSingle.classList.toggle('is-active', mode === 'single')
  modeKaraoke.classList.toggle('is-active', mode === 'karaoke')
  barLabel.textContent = mode === 'karaoke' ? 'カラオケバー' : '単音バー'
  barChip.textContent = mode === 'karaoke' ? `Key ${NOTE_NAMES[targetMidi % 12]}` : '単音'
  clearLaneBars()
  syncStatusPills()
}

const setPlaybackMode = (mode: PlaybackMode) => {
  playbackMode = mode
  playbackRecordButton.classList.toggle('is-active', mode === 'record')
  playbackPianoButton.classList.toggle('is-active', mode === 'piano')
  if (mode === 'record' && isMelodyPlaying) {
    stopMelodyPlayback()
  }
  if (mode === 'piano' && isRecordPlaying) {
    recordedAudio.pause()
  }
  updateMelodyControls()
  setMelodyButtonLabel()
}

const isPlaying = () => isMelodyPlaying || isRecordPlaying
const hasPlayableMelody = () => melodySequence.some((event) => event.midi !== null)
const isPlayButtonActive = () => (playbackMode === 'record' ? isRecordPlaying : isMelodyPlaying)

const syncStatusPills = () => {
  appRoot.dataset.recording = String(isRecording)
  appRoot.dataset.playing = String(isPlaying())

  recordPill.dataset.active = String(isRecording)
  recordStatus.textContent = isRecording ? '録音中' : '停止中'

  playPill.dataset.active = String(isPlaying())
  playStatusText.textContent = isPlaying() ? '再生中' : '待機中'

  if (isRecording) {
    barStatus.dataset.state = 'rec'
    barStatus.textContent = '録音中'
  } else if (isPlaying()) {
    barStatus.dataset.state = 'play'
    barStatus.textContent = '再生中'
  } else {
    barStatus.dataset.state = 'idle'
    barStatus.textContent = '待機中'
  }
}

const setStartButtonLabel = () => {
  startButton.textContent = isRunning ? '停止' : '開始'
}

const setRecordButtonLabel = () => {
  recordButton.textContent = isRecording ? '録音停止' : '録音開始'
  recordStatus.textContent = isRecording ? '録音中' : '停止中'
  syncStatusPills()
}

const setMelodyButtonLabel = () => {
  playMelodyButton.textContent = isPlayButtonActive() ? '停止' : '再生'
  syncStatusPills()
}

const updateMelodyControls = () => {
  if (playbackMode === 'record') {
    playMelodyButton.disabled = isRecording || !hasRecordedAudio
    melodySpeedSelect.disabled = true
    return
  }

  const hasMelody = hasPlayableMelody()
  playMelodyButton.disabled = isRecording || isToneLoading
  melodySpeedSelect.disabled = isRecording || isToneLoading || !hasMelody
}

const setControls = (isWorking: boolean) => {
  startButton.disabled = isWorking
  retryButton.disabled = isWorking
  recordButton.disabled = isWorking

  const toneDisabled = isWorking
  playToneButton.disabled = toneDisabled
  playOctaveButton.disabled = toneDisabled
  updateMelodyControls()

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
  stopToneAudio()
}

const getAudioContextClass = (): AudioContextClass | undefined => {
  return window.AudioContext ?? (window as Window & { webkitAudioContext?: AudioContextClass }).webkitAudioContext
}

const buildAudioConstraints = () => {
  const supported = navigator.mediaDevices?.getSupportedConstraints
    ? navigator.mediaDevices.getSupportedConstraints()
    : {}
  const constraints: MediaTrackConstraints = {}

  if (supported.channelCount) {
    constraints.channelCount = { ideal: 1 }
  }
  if (supported.sampleRate) {
    constraints.sampleRate = { ideal: 44100 }
  }
  if (supported.sampleSize) {
    constraints.sampleSize = { ideal: 16 }
  }
  if (supported.echoCancellation) {
    constraints.echoCancellation = false
  }
  if (supported.noiseSuppression) {
    constraints.noiseSuppression = false
  }
  if (supported.autoGainControl) {
    constraints.autoGainControl = false
  }
  return constraints
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

const calculateRms = (buffer: Float32Array) => {
  let sum = 0
  for (let i = 0; i < buffer.length; i += 1) {
    const value = buffer[i]
    sum += value * value
  }
  return Math.sqrt(sum / buffer.length)
}

const ensurePlaybackContext = async () => {
  const AudioContextCtor = getAudioContextClass()
  if (!AudioContextCtor) {
    setToneStatus('error', 'このブラウザはAudioContextに未対応です。')
    return null
  }

  if (!playbackContext || playbackContext.state === 'closed') {
    playbackContext = new AudioContextCtor()
    hasAudioUnlocked = false
  }

  if (playbackContext.state === 'suspended') {
    await playbackContext.resume()
  }

  return playbackContext
}

const unlockAudioContext = async (context: AudioContext) => {
  if (hasAudioUnlocked) return true

  try {
    if (context.state === 'suspended') {
      await context.resume()
    }
  } catch {
    // resume失敗時は後続の無音再生で試行する
  }

  try {
    const buffer = context.createBuffer(1, 1, context.sampleRate)
    const source = context.createBufferSource()
    const gain = context.createGain()
    gain.gain.value = 0
    source.buffer = buffer
    source.connect(gain)
    gain.connect(context.destination)
    source.start(0)
    source.stop(0)
    hasAudioUnlocked = true
    return true
  } catch (error) {
    const detail = formatError(error)
    forceMediaTone = true
    setToneStatus(
      'error',
      detail
        ? `AudioContextの起動に失敗しました（${detail}）`
        : 'AudioContextの起動に失敗しました。Safariでは「開始」後に再試行してください。',
    )
    return false
  }
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
  if (shouldUseMediaTone()) {
    setToneStatus('ready', '簡易音で再生します')
    return null
  }

  const context = await ensurePlaybackContext()
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
  } catch (error) {
    pianoInstrument = null
    forceMediaTone = true
    const detail = formatError(error)
    setToneStatus(
      'error',
      detail
        ? `ピアノ音の読み込みに失敗しました（${detail}）`
        : 'ピアノ音の読み込みに失敗しました。簡易音で再生します。',
    )
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

const scheduleOscillatorNote = (
  context: AudioContext,
  frequency: number,
  startTime: number,
  duration: number,
  gainValue = 0.18,
) => {
  const osc = context.createOscillator()
  const gain = context.createGain()
  const safeDuration = Math.max(0.05, duration)
  const attack = Math.min(0.02, safeDuration * 0.25)
  const release = Math.min(0.03, safeDuration * 0.25)
  const sustainStart = startTime + attack
  const sustainEnd = Math.max(sustainStart, startTime + safeDuration - release)

  gain.gain.setValueAtTime(0, startTime)
  gain.gain.linearRampToValueAtTime(gainValue, sustainStart)
  gain.gain.setValueAtTime(gainValue, sustainEnd)
  gain.gain.linearRampToValueAtTime(0, startTime + safeDuration)

  osc.type = 'sine'
  osc.frequency.setValueAtTime(frequency, startTime)
  osc.connect(gain)
  gain.connect(context.destination)
  osc.start(startTime)
  osc.stop(startTime + safeDuration + 0.05)

  return {
    stop: () => {
      try {
        osc.stop()
      } catch {
        // ignore
      }
    },
  }
}

const encodeWav = (samples: Float32Array, sampleRate: number) => {
  const length = samples.length
  const buffer = new ArrayBuffer(44 + length * 2)
  const view = new DataView(buffer)

  const writeString = (offset: number, value: string) => {
    for (let i = 0; i < value.length; i += 1) {
      view.setUint8(offset + i, value.charCodeAt(i))
    }
  }

  writeString(0, 'RIFF')
  view.setUint32(4, 36 + length * 2, true)
  writeString(8, 'WAVE')
  writeString(12, 'fmt ')
  view.setUint32(16, 16, true)
  view.setUint16(20, 1, true)
  view.setUint16(22, 1, true)
  view.setUint32(24, sampleRate, true)
  view.setUint32(28, sampleRate * 2, true)
  view.setUint16(32, 2, true)
  view.setUint16(34, 16, true)
  writeString(36, 'data')
  view.setUint32(40, length * 2, true)

  let offset = 44
  for (let i = 0; i < length; i += 1) {
    const clamped = Math.max(-1, Math.min(1, samples[i]))
    view.setInt16(offset, Math.round(clamped * 0x7fff), true)
    offset += 2
  }

  return buffer
}

const buildSineSamples = (frequency: number, duration: number, sampleRate: number, amplitude: number) => {
  const totalSamples = Math.max(1, Math.ceil(duration * sampleRate))
  const buffer = new Float32Array(totalSamples)
  const attackSamples = Math.max(1, Math.floor(Math.min(0.02, duration * 0.25) * sampleRate))
  const releaseSamples = Math.max(1, Math.floor(Math.min(0.03, duration * 0.25) * sampleRate))
  const sustainSamples = Math.max(0, totalSamples - attackSamples - releaseSamples)

  for (let i = 0; i < totalSamples; i += 1) {
    const t = i / sampleRate
    let env = 1
    if (i < attackSamples) {
      env = i / attackSamples
    } else if (i >= attackSamples + sustainSamples) {
      const relIndex = i - attackSamples - sustainSamples
      env = 1 - relIndex / Math.max(1, releaseSamples)
    }
    buffer[i] = Math.sin(2 * Math.PI * frequency * t) * amplitude * env
  }

  return buffer
}

const buildMelodySamples = (
  events: MelodyEvent[],
  speed: number,
  sampleRate: number,
  amplitude: number,
) => {
  const clampedSpeed = speed > 0 ? speed : 1
  const durations = events.map((event) => event.duration / clampedSpeed)
  const totalDuration = durations.reduce((sum, value) => sum + value, 0)
  const totalSamples = Math.max(1, Math.ceil(totalDuration * sampleRate))
  const buffer = new Float32Array(totalSamples)

  let cursor = 0
  for (let index = 0; index < events.length; index += 1) {
    const event = events[index]
    const duration = durations[index]
    const samples = Math.max(1, Math.ceil(duration * sampleRate))
    if (event.midi === null) {
      cursor += samples
      continue
    }

    const frequency = midiToFrequency(event.midi)
    const attackSamples = Math.max(1, Math.floor(Math.min(0.02, duration * 0.25) * sampleRate))
    const releaseSamples = Math.max(1, Math.floor(Math.min(0.03, duration * 0.25) * sampleRate))
    const sustainSamples = Math.max(0, samples - attackSamples - releaseSamples)

    for (let i = 0; i < samples && cursor + i < totalSamples; i += 1) {
      const t = i / sampleRate
      let env = 1
      if (i < attackSamples) {
        env = i / attackSamples
      } else if (i >= attackSamples + sustainSamples) {
        const relIndex = i - attackSamples - sustainSamples
        env = 1 - relIndex / Math.max(1, releaseSamples)
      }
      buffer[cursor + i] = Math.sin(2 * Math.PI * frequency * t) * amplitude * env
    }
    cursor += samples
  }

  return buffer
}

const playSamplesViaMedia = async (samples: Float32Array, sampleRate: number, onEnded?: () => void) => {
  stopToneAudio()
  const audio = getToneAudio()
  const wavBuffer = encodeWav(samples, sampleRate)
  toneObjectUrl = URL.createObjectURL(new Blob([wavBuffer], { type: 'audio/wav' }))
  audio.src = toneObjectUrl
  audio.onended = onEnded ?? null
  try {
    await audio.play()
  } catch (error) {
    const detail = formatError(error)
    setToneStatus(
      'error',
      detail ? `音声の再生に失敗しました（${detail}）` : '音声の再生に失敗しました',
    )
  }
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

const median = (values: number[]) => {
  if (values.length === 0) return null
  const sorted = [...values].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  if (sorted.length % 2 === 0) {
    return (sorted[mid - 1] + sorted[mid]) / 2
  }
  return sorted[mid]
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

  const valid = bucket.filter(
    (frame) => frame.confidence >= MIN_CONFIDENCE && (frame.midi !== null || frame.frequency !== null),
  )
  let midi: number | null = null

  if (valid.length > 0) {
    const counts = new Map<number, number>()
    for (const frame of valid) {
      if (frame.midi === null) continue
      counts.set(frame.midi, (counts.get(frame.midi) ?? 0) + 1)
    }
    if (counts.size > 0) {
      let bestMidi = 0
      let bestCount = -1
      counts.forEach((count, note) => {
        if (count > bestCount) {
          bestCount = count
          bestMidi = note
        }
      })
      midi = bestMidi
    } else {
      const avgFrequency = valid.reduce((sum, frame) => sum + (frame.frequency ?? 0), 0) / valid.length
      midi = Math.round(hzToMidi(avgFrequency))
    }
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

const buildKaraokeEvents = (sequence: MelodyEvent[]) => {
  const events: KaraokeEvent[] = []
  let cursor = 0
  for (const event of sequence) {
    if (event.midi !== null) {
      events.push({ midi: event.midi, start: cursor, duration: event.duration })
    }
    cursor += event.duration
  }
  return events
}

const buildKaraokeSegments = (
  frames: RecordedFrame[],
  gapToleranceSeconds: number,
  midiTolerance: number,
) => {
  if (frames.length === 0) return []
  const sorted = [...frames].sort((a, b) => a.t - b.t)
  const segments: KaraokeSegment[] = []
  let active: KaraokeSegment | null = null
  let lastTime = 0

  for (const frame of sorted) {
    if (frame.midi === null || frame.confidence < MIN_CONFIDENCE) {
      continue
    }

    if (!active) {
      active = { midi: frame.midi, start: frame.t, end: frame.t }
      lastTime = frame.t
      continue
    }

    const gap = frame.t - lastTime
    const midiDiff = Math.abs(frame.midi - active.midi)
    if (gap <= gapToleranceSeconds && midiDiff <= midiTolerance) {
      active.end = frame.t
      lastTime = frame.t
      continue
    }

    const holdEnd = Math.min(frame.t, active.end + KARAOKE_HOLD_SECONDS)
    active.end = Math.max(active.end, holdEnd)
    if (active.end - active.start < KARAOKE_MIN_SEGMENT_SECONDS) {
      active.end = active.start + KARAOKE_MIN_SEGMENT_SECONDS
    }
    segments.push(active)
    active = { midi: frame.midi, start: frame.t, end: frame.t }
    lastTime = frame.t
  }

  if (active) {
    active.end += KARAOKE_HOLD_SECONDS
    if (active.end - active.start < KARAOKE_MIN_SEGMENT_SECONDS) {
      active.end = active.start + KARAOKE_MIN_SEGMENT_SECONDS
    }
    segments.push(active)
  }

  return segments
}

const getLaneMetrics = () => {
  const rect = lane.getBoundingClientRect()
  const width = Math.max(0, rect.width - LANE_PADDING * 2)
  const height = Math.max(0, rect.height - LANE_TOP_PADDING - LANE_BOTTOM_PADDING)
  return { rect, width, height }
}

const midiToLaneY = (
  midi: number,
  laneMetrics: { rect: DOMRect; width: number; height: number },
  range: { min: number; max: number },
) => {
  const span = Math.max(1, range.max - range.min)
  const clampedMidi = clamp(midi, range.min, range.max)
  const ratio = span === 0 ? 0.5 : (clampedMidi - range.min) / span
  const y =
    LANE_TOP_PADDING +
    (1 - ratio) * laneMetrics.height -
    LANE_BAR_HEIGHT / 2
  const maxY = laneMetrics.rect.height - LANE_BOTTOM_PADDING - LANE_BAR_HEIGHT
  return clamp(y, LANE_TOP_PADDING, maxY)
}

const getKaraokeRange = () => {
  let minMidi = targetMidi - 6
  let maxMidi = targetMidi + 6
  const samples: number[] = []

  if (recordedFrames.length > 0 && (isRecording || isPlaying())) {
    recordedFrames.forEach((frame) => {
      if (frame.midi !== null) samples.push(frame.midi)
    })
  } else if (karaokeEvents.length > 0) {
    karaokeEvents.forEach((event) => samples.push(event.midi))
  } else if (lastStableMetrics) {
    samples.push(lastStableMetrics.midi)
  }

  if (samples.length > 0) {
    const rawMin = Math.min(...samples)
    const rawMax = Math.max(...samples)
    const center = (rawMin + rawMax) / 2
    const halfRange = Math.max(KARAOKE_MIN_RANGE / 2, (rawMax - rawMin) / 2 + KARAOKE_RANGE_PADDING)
    minMidi = center - halfRange
    maxMidi = center + halfRange
  } else {
    minMidi -= KARAOKE_RANGE_PADDING
    maxMidi += KARAOKE_RANGE_PADDING
  }

  const rangeSize = Math.max(KARAOKE_MIN_RANGE, maxMidi - minMidi)
  if (maxMidi - minMidi < rangeSize) {
    const mid = (maxMidi + minMidi) / 2
    minMidi = mid - rangeSize / 2
    maxMidi = mid + rangeSize / 2
  }

  if (minMidi < TARGET_START_MIDI) {
    const diff = TARGET_START_MIDI - minMidi
    minMidi = TARGET_START_MIDI
    maxMidi += diff
  }
  if (maxMidi > TARGET_END_MIDI) {
    const diff = maxMidi - TARGET_END_MIDI
    maxMidi = TARGET_END_MIDI
    minMidi -= diff
  }

  minMidi = clamp(minMidi, TARGET_START_MIDI, TARGET_END_MIDI - KARAOKE_MIN_RANGE)
  maxMidi = clamp(maxMidi, TARGET_START_MIDI + KARAOKE_MIN_RANGE, TARGET_END_MIDI)

  return { min: minMidi, max: maxMidi }
}

const clearLaneBars = () => {
  laneTargets.forEach((target) => {
    target.style.opacity = '0'
    target.style.transform = 'scaleX(0.6)'
  })
  laneTrails.forEach((trail) => {
    trail.style.opacity = '0'
    trail.style.transform = 'scaleX(0.6)'
  })
  laneDot.style.opacity = '0.4'
}

const hideLaneTrails = () => {
  laneTrails.forEach((trail) => {
    trail.style.opacity = '0'
  })
}

const updateLaneCurrentState = (activeSegment: KaraokeSegment | undefined) => {
  laneCurrentText.textContent = activeSegment
    ? `現在: ${midiToSolfege(activeSegment.midi)}`
    : '現在: --'
  laneCentsText.textContent = '--'
}

const renderLaneTrails = (
  visibleSegments: KaraokeSegment[],
  trailStart: number,
  now: number,
  laneMetrics: { rect: DOMRect; width: number; height: number },
  range: { min: number; max: number },
) => {
  if (visibleSegments.length === 0) {
    hideLaneTrails()
    return
  }

  const maxWidth = laneMetrics.rect.width - LANE_PADDING * 2
  const windowDuration = Math.max(0.01, now - trailStart)
  const slots = laneTrails.length
  const recentSegments = visibleSegments.slice(-slots)
  for (let i = 0; i < slots; i += 1) {
    const trail = laneTrails[i]
    const segment = recentSegments[i]
    if (!segment) {
      trail.style.opacity = '0'
      continue
    }
    const start = Math.max(segment.start, trailStart)
    const end = Math.min(segment.end, now)
    const left = LANE_PADDING + ((start - trailStart) / windowDuration) * maxWidth
    const right = LANE_PADDING + ((end - trailStart) / windowDuration) * maxWidth
    const maxRight = LANE_PADDING + maxWidth
    const rawWidth = Math.max(KARAOKE_MIN_BAR_WIDTH, right - left)
    const width = Math.max(KARAOKE_MIN_BAR_WIDTH, Math.min(rawWidth, maxRight - left))
    const top = midiToLaneY(segment.midi, laneMetrics, range)
    trail.style.left = `${left}px`
    trail.style.top = `${top}px`
    trail.style.width = `${width}px`
    trail.style.opacity = '1'
    trail.style.transform = 'scaleX(1)'
  }
}

const getPlaybackSeconds = () => {
  if (isRecordPlaying) {
    return Math.max(0, recordedAudio.currentTime)
  }
  if (isMelodyPlaying) {
    const elapsed = Math.max(0, (performance.now() - karaokeStartAt) / 1000)
    return elapsed * (melodySpeed > 0 ? melodySpeed : 1)
  }
  return 0
}

const renderKaraokeBar = () => {
  if (currentMode !== 'karaoke') {
    clearLaneBars()
    return
  }

  laneDot.style.opacity = isRecording || isPlaying() ? '1' : '0.4'

  const laneMetrics = getLaneMetrics()
  const range = getKaraokeRange()
  if (laneMetrics.width <= 0 || laneMetrics.height <= 0) {
    clearLaneBars()
    return
  }

  laneTargets.forEach((target) => {
    target.style.opacity = '0'
    target.style.transform = 'scaleX(0.6)'
  })

  if (isRecording) {
    const now = Math.max(0, (performance.now() - recordStartTime) / 1000)
    const trailStart = Math.max(0, now - KARAOKE_TRAIL_SECONDS)
    const segments = buildKaraokeSegments(
      recordedFrames,
      KARAOKE_GAP_TOLERANCE,
      KARAOKE_MIDI_TOLERANCE,
    )
    const visibleSegments = segments.filter(
      (segment) => segment.end >= trailStart && segment.start <= now,
    )
    const activeSegment = segments.find((segment) => segment.start <= now && segment.end >= now)
    updateLaneCurrentState(activeSegment)
    renderLaneTrails(visibleSegments, trailStart, now, laneMetrics, range)
    return
  }

  if (!isPlaying() || karaokeSegments.length === 0) {
    laneCurrentText.textContent = '現在: --'
    laneCentsText.textContent = '--'
    clearLaneBars()
    return
  }

  const now = getPlaybackSeconds()
  const trailStart = Math.max(0, now - KARAOKE_TRAIL_SECONDS)
  const visibleSegments = karaokeSegments.filter(
    (segment) => segment.end >= trailStart && segment.start <= now,
  )
  const activeSegment = karaokeSegments.find((segment) => segment.start <= now && segment.end >= now)
  updateLaneCurrentState(activeSegment)
  renderLaneTrails(visibleSegments, trailStart, now, laneMetrics, range)
}

const startKaraokeAnimation = () => {
  if (karaokeAnimationId !== null) return
  const tick = () => {
    karaokeAnimationId = requestAnimationFrame(tick)
    renderKaraokeBar()
  }
  karaokeAnimationId = requestAnimationFrame(tick)
}

const stopKaraokeAnimation = () => {
  if (karaokeAnimationId === null) return
  cancelAnimationFrame(karaokeAnimationId)
  karaokeAnimationId = null
}

const deriveStableMetrics = (frequency: number | null, confidence: number): PitchMetrics | null => {
  if (frequency === null || confidence < MIN_CONFIDENCE) {
    silenceFrames += 1
    frequencyWindow = []
    candidateMidi = null
    candidateFrames = 0
    if (silenceFrames >= STABILITY_SILENCE_FRAMES) {
      stableMidi = null
    } else if (lastStableMetrics && silenceFrames <= STABILITY_HANGOVER_FRAMES) {
      return lastStableMetrics
    }
    return null
  }

  silenceFrames = 0
  frequencyWindow.push(frequency)
  if (frequencyWindow.length > STABILITY_WINDOW) {
    frequencyWindow.shift()
  }
  const medianFrequency = median(frequencyWindow)
  if (medianFrequency === null) return null

  const candidate = Math.round(hzToMidi(medianFrequency))
  if (candidateMidi === candidate) {
    candidateFrames += 1
  } else {
    candidateMidi = candidate
    candidateFrames = 1
  }

  if (candidateFrames >= STABILITY_HOLD_FRAMES) {
    stableMidi = candidate
  }

  if (stableMidi === null) return null

  const stableFrequency = stableMidi === candidateMidi ? medianFrequency : midiToFrequency(stableMidi)
  const targetFrequency = midiToFrequency(targetMidi)
  const centsFromTarget = 1200 * Math.log2(stableFrequency / targetFrequency)

  return {
    frequency: stableFrequency,
    confidence,
    midi: stableMidi,
    note: midiToNote(stableMidi),
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
  gaugeLabel.textContent = `${cents >= 0 ? '+' : ''}${cents.toFixed(1)}c`
}

const updatePitchDisplay = (metricsData: PitchMetrics | null, confidence: number) => {
  const isReliable = metricsData !== null
  metrics.dataset.low = isReliable ? 'false' : 'true'

  if (!isReliable) {
    currentNote.textContent = '…'
    freqValue.textContent = '…'
    centsValue.textContent = '…'
    if (currentMode === 'single') {
      laneCurrentText.textContent = '現在: --'
      laneCentsText.textContent = '--'
    }
    updateGauge(null, confidence)
  } else {
    const midi = metricsData.midi
    currentNote.innerHTML = `<span class="pp-note-main">${midiToNote(midi)}</span><span class="pp-note-sub">${midiToSolfege(
      midi,
    )}</span>`
    freqValue.textContent = `${metricsData.frequency.toFixed(2)} Hz`
    centsValue.textContent = `${metricsData.centsFromTarget >= 0 ? '+' : ''}${metricsData.centsFromTarget.toFixed(1)} cents`
    if (currentMode === 'single') {
      laneCurrentText.textContent = `現在: ${midiToSolfege(midi)}`
      laneCentsText.textContent = `${metricsData.centsFromTarget >= 0 ? '+' : ''}${metricsData.centsFromTarget.toFixed(0)}c`
    }
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
    midi: metricsData?.midi ?? null,
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
  if (waveform) {
    waveform.textContent = preview
  }

  if (typeof analyser.getFloatTimeDomainData === 'function') {
    analyser.getFloatTimeDomainData(floatData)
  } else {
    for (let i = 0; i < byteData.length; i += 1) {
      floatData[i] = (byteData[i] - 128) / 128
    }
  }

  const rms = calculateRms(floatData)
  if (rms < MIN_RMS) {
    lastConfidence = 0
    smoothedFrequency = null
    lastStableMetrics = deriveStableMetrics(null, 0)
    updatePitchDisplay(null, 0)
    recordFrame(null, 0)
    animationId = requestAnimationFrame(renderWaveform)
    return
  }

  const { frequency, confidence } = autoCorrelate(floatData, audioContext?.sampleRate ?? 44100)
  lastConfidence = confidence

  if (frequency !== null && confidence >= MIN_CONFIDENCE) {
    smoothedFrequency = smoothedFrequency === null ? frequency : smoothedFrequency + SMOOTHING * (frequency - smoothedFrequency)
  }

  const metricsData = deriveStableMetrics(smoothedFrequency, confidence)
  lastStableMetrics = metricsData
  updatePitchDisplay(metricsData, confidence)
  recordFrame(metricsData, confidence)
  if (currentMode === 'karaoke') {
    renderKaraokeBar()
  }

  animationId = requestAnimationFrame(renderWaveform)
}

const renderReview = () => {
  const hasReviewUI = !!(reviewStats && reviewScore && reviewChallenge && reviewList && reviewCanvas)
  if (recordedFrames.length === 0) {
    if (hasReviewUI) {
      reviewStats.textContent = '-'
      reviewScore.textContent = '-'
      reviewChallenge.textContent = '-'
      reviewList.textContent = '-'
    }
    melodySequence = []
    karaokeEvents = []
    karaokeSegments = []
    updateMelodyControls()
    if (isMelodyPlaying) {
      stopMelodyPlayback()
    }
    if (hasReviewUI) {
      const ctx = reviewCanvas.getContext('2d')
      if (ctx) {
        ctx.clearRect(0, 0, reviewCanvas.width, reviewCanvas.height)
      }
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

  if (hasReviewUI) {
    reviewStats.textContent = `平均|cents|: ${avgAbsCents ? avgAbsCents.toFixed(1) + '¢' : '--'} / 平均confidence: ${Math.round(
      avgConfidence * 100,
    )}% / 有効サンプル: ${valid.length}/${recordedFrames.length}`
  }

  const vibratoLabel = vibrato
    ? `揺れ周期: ${vibrato.rate.toFixed(1)}Hz / 幅: ${vibrato.depth.toFixed(1)}¢ / ${
        vibrato.hasVibrato ? '検出OK' : '弱め'
      }`
    : 'ビブラート: --'

  if (hasReviewUI) {
    reviewScore.textContent = `安定度: ${stabilityScore ?? '--'} / 100\n${vibratoLabel}`
  }

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
  if (hasReviewUI) {
    reviewChallenge.textContent = challenge
  }

  melodySequence = buildMelodySequence(recordedFrames, MELODY_STEP_SECONDS)
  karaokeEvents = buildKaraokeEvents(melodySequence)
  karaokeSegments = buildKaraokeSegments(
    recordedFrames,
    KARAOKE_GAP_TOLERANCE,
    KARAOKE_MIDI_TOLERANCE,
  )
  updateMelodyControls()
  const hasMelody = hasPlayableMelody()
  if (!hasMelody && isMelodyPlaying) {
    stopMelodyPlayback()
  }

  if (hasReviewUI) {
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

    const audioConstraints = buildAudioConstraints()
    const hasConstraints = Object.keys(audioConstraints).length > 0
    mediaStream = await navigator.mediaDevices.getUserMedia({
      audio: hasConstraints ? audioConstraints : true,
    })
    const track = mediaStream.getAudioTracks()[0]
    if (track?.applyConstraints && hasConstraints) {
      try {
        await track.applyConstraints(audioConstraints)
      } catch {
        // ignore constraint errors and continue with default settings
      }
    }
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
  if (waveform) {
    waveform.textContent = '-'
  }
  setStartButtonLabel()
  setStatus('idle', '停止しました。開始ボタンを押してください。')
  setControls(false)
  clearLaneBars()
  stopKaraokeAnimation()
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
  const context = await ensurePlaybackContext()
  if (!context) {
    setToneStatus('ready', '簡易音で再生します')
    const midi = targetMidi + octaveShift
    const samples = buildSineSamples(midiToFrequency(midi), 1.2, TONE_SAMPLE_RATE, REFERENCE_SAMPLE_AMPLITUDE)
    await playSamplesViaMedia(samples, TONE_SAMPLE_RATE)
    return
  }

  const unlocked = await unlockAudioContext(context)
  if (!unlocked || context.state !== 'running') {
    forceMediaTone = true
  }

  if (shouldUseMediaTone()) {
    setToneStatus('ready', '簡易音で再生します')
    const midi = targetMidi + octaveShift
    const samples = buildSineSamples(midiToFrequency(midi), 1.2, TONE_SAMPLE_RATE, REFERENCE_SAMPLE_AMPLITUDE)
    await playSamplesViaMedia(samples, TONE_SAMPLE_RATE)
    return
  }

  const instrument = await loadPianoSoundfont()

  stopReferenceTone()

  const midi = targetMidi + octaveShift
  if (instrument) {
    activeNote = instrument.play(midiToSoundfontNote(midi), context.currentTime, {
      duration: 1.2,
      gain: PIANO_REFERENCE_GAIN,
    })
    return
  }
  if (shouldUseMediaTone()) {
    setToneStatus('ready', '簡易音で再生します')
    const samples = buildSineSamples(midiToFrequency(midi), 1.2, TONE_SAMPLE_RATE, REFERENCE_SAMPLE_AMPLITUDE)
    await playSamplesViaMedia(samples, TONE_SAMPLE_RATE)
    return
  }
  activeNote = scheduleOscillatorNote(
    context,
    midiToFrequency(midi),
    context.currentTime,
    1.2,
    OSC_REFERENCE_GAIN,
  )
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
  stopToneAudio()
  isMelodyPlaying = false
  setMelodyButtonLabel()
  if (!isRunning && !isRecordPlaying) {
    stopKaraokeAnimation()
    renderKaraokeBar()
  }
}

const playMelodyViaMediaTone = async () => {
  setToneStatus('ready', '簡易音で再生します')
  stopReferenceTone()
  stopMelodyPlayback()
  isMelodyPlaying = true
  setMelodyButtonLabel()
  karaokeStartAt = performance.now()
  if (!isRunning) {
    startKaraokeAnimation()
  }
  const samples = buildMelodySamples(melodySequence, melodySpeed, TONE_SAMPLE_RATE, MELODY_SAMPLE_AMPLITUDE)
  await playSamplesViaMedia(samples, TONE_SAMPLE_RATE, () => {
    isMelodyPlaying = false
    setMelodyButtonLabel()
    if (!isRunning && !isRecordPlaying) {
      stopKaraokeAnimation()
      renderKaraokeBar()
    }
  })
}

const playMelody = async () => {
  if (isMelodyPlaying) {
    stopMelodyPlayback()
    return
  }

  if (isRecording) return

  if (playbackMode === 'record') {
    if (!hasRecordedAudio) {
      setStatus('idle', '録音データがありません。録音してから再生してください。')
      return
    }
    if (isRecordPlaying) {
      recordedAudio.pause()
      return
    }
    try {
      await recordedAudio.play()
      return
    } catch (error) {
      const detail = formatError(error)
      setStatus('error', detail ? `録音再生に失敗しました（${detail}）` : '録音再生に失敗しました。')
      return
    }
  }

  if (!hasPlayableMelody()) {
    setStatus('idle', '録音データがありません。録音してから再生してください。')
    return
  }

  const context = await ensurePlaybackContext()
  if (!context) {
    await playMelodyViaMediaTone()
    return
  }

  const unlocked = await unlockAudioContext(context)
  if (!unlocked || context.state !== 'running') {
    forceMediaTone = true
  }

  if (shouldUseMediaTone()) {
    await playMelodyViaMediaTone()
    return
  }

  const instrument = await loadPianoSoundfont()

  stopReferenceTone()
  stopMelodyPlayback()

  isMelodyPlaying = true
  setMelodyButtonLabel()
  karaokeStartAt = performance.now()
  if (!isRunning) {
    startKaraokeAnimation()
  }

  let time = context.currentTime + 0.05
  let totalDuration = 0
  const speed = melodySpeed > 0 ? melodySpeed : 1

  for (const event of melodySequence) {
    const duration = event.duration / speed
    if (event.midi !== null) {
      if (instrument) {
        melodyNotes.push(
          instrument.play(midiToSoundfontNote(event.midi), time, {
            duration,
            gain: PIANO_MELODY_GAIN,
          }),
        )
      } else if (!instrument) {
        melodyNotes.push(
          scheduleOscillatorNote(context, midiToFrequency(event.midi), time, duration, OSC_MELODY_GAIN),
        )
      }
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
  melodySequence = []
  karaokeEvents = []
  karaokeSegments = []
  hasRecordedAudio = false
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
    hasRecordedAudio = true
    updateMelodyControls()
    renderReview()
  }

  mediaRecorder.start()
  isRecording = true
  if (!recordedAudio.paused) {
    recordedAudio.pause()
  }
  isRecordPlaying = false
  setRecordButtonLabel()
  updateMelodyControls()
  playRecordButton.disabled = true
}

const stopRecording = () => {
  if (!isRecording) return
  if (mediaRecorder && mediaRecorder.state !== 'inactive') {
    mediaRecorder.stop()
  }
  isRecording = false
  setRecordButtonLabel()
  setControls(false)
}

buildTargetOptions()
targetSelect.value = String(targetMidi)
setMode('single')
setPlaybackMode('piano')
setStartButtonLabel()
setRecordButtonLabel()
setMelodyButtonLabel()
setToneStatus('idle', 'ピアノ音は未読み込み')
syncStatusPills()
updateMelodyControls()
setControls(false)
renderKaraokeBar()

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

modeSingle.addEventListener('click', () => {
  setMode('single')
})

modeKaraoke.addEventListener('click', () => {
  setMode('karaoke')
})

playbackRecordButton.addEventListener('click', () => {
  setPlaybackMode('record')
})

playbackPianoButton.addEventListener('click', () => {
  setPlaybackMode('piano')
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

recordedAudio.addEventListener('play', () => {
  isRecordPlaying = true
  karaokeStartAt = performance.now() - recordedAudio.currentTime * 1000
  if (!isRunning) {
    startKaraokeAnimation()
  }
  syncStatusPills()
  setMelodyButtonLabel()
})

const handleRecordedAudioStopped = () => {
  isRecordPlaying = false
  syncStatusPills()
  setMelodyButtonLabel()
  if (!isRunning && !isMelodyPlaying) {
    stopKaraokeAnimation()
    renderKaraokeBar()
  }
}

recordedAudio.addEventListener('pause', handleRecordedAudioStopped)
recordedAudio.addEventListener('ended', handleRecordedAudioStopped)

targetSelect.addEventListener('change', () => {
  const value = Number(targetSelect.value)
  if (!Number.isNaN(value)) {
    targetMidi = value
    if (currentMode === 'karaoke') {
      barChip.textContent = `Key ${NOTE_NAMES[targetMidi % 12]}`
    }
    if (lastStableMetrics) {
      const targetFrequency = midiToFrequency(targetMidi)
      const centsFromTarget = 1200 * Math.log2(lastStableMetrics.frequency / targetFrequency)
      updatePitchDisplay({ ...lastStableMetrics, centsFromTarget }, lastConfidence)
    } else {
      updatePitchDisplay(null, lastConfidence)
    }
  }
})
