import './style.css'
import { CaptureSession, reanalyze } from './audio/capture.ts'
import type { CaptureResult } from './audio/capture.ts'
import { VoicePlayer } from './audio/player.ts'
import type { AnalysisMode, PitchFrame } from './analysis/pipeline.ts'
import { buildNotes } from './analysis/notes.ts'
import type { PitchMode } from './analysis/notes.ts'
import { mountView } from './ui/view.ts'
import { drawTimeline, noteLabel } from './ui/timeline.ts'
import type { PitchRange } from './ui/timeline.ts'
import { mountScorePanel } from './ui/score-panel.ts'

type Phase =
  | 'idle'
  | 'requesting'
  | 'recording'
  | 'analyzing'
  | 'ready'
  | 'loading'
  | 'playing'
const root = document.querySelector<HTMLDivElement>('#app')!
const ui = mountView(root)
const scorePanel = mountScorePanel(ui.score)
const player = new VoicePlayer()
let phase: Phase = 'idle'
let mode: AnalysisMode = 'song'
let pitchMode: PitchMode = 'continuous'
let source: 'original' | 'piano' = 'original'
let capture: CaptureSession | null = null
let recording: CaptureResult | null = null
let frames: PitchFrame[] = []
let duration = 0
let cursor = 0
let revision = 0
let frameId = 0
const ranges: Record<string, PitchRange> = {
  wide: { min: 33, max: 83 },
  low: { min: 33, max: 57 },
  middle: { min: 48, max: 72 },
  high: { min: 60, max: 83 },
}

/** 共通時計を分秒表示へ変換する。 */
function formatTime(seconds: number): string {
  return `${Math.floor(seconds / 60)}:${Math.floor(seconds % 60)
    .toString()
    .padStart(2, '0')}`
}
/** 失敗は操作可能な状態と合わせて明示する。 */
function status(message: string, error = false): void {
  ui.status.textContent = message
  ui.status.classList.toggle('error', error)
}
/** 状態をネイティブの操作可否・ラベル・補助文へ同時に反映する。 */
function sync(): void {
  const busy =
    phase === 'requesting' || phase === 'recording' || phase === 'analyzing'
  const playing = phase === 'playing' || phase === 'loading'
  ui.record.disabled = phase === 'analyzing'
  ui.record.innerHTML =
    phase === 'requesting'
      ? 'キャンセル'
      : phase === 'recording'
        ? '■ 録音を止める'
        : `<span aria-hidden="true">●</span> ${recording ? 'もう一度録音する' : '録音する'}`
  ui.record.setAttribute(
    'aria-label',
    phase === 'recording'
      ? '録音を止める'
      : phase === 'requesting'
        ? 'マイク準備をキャンセル'
        : recording
          ? 'もう一度録音する'
          : '録音する',
  )
  ui.modes.forEach((input) => {
    input.disabled = busy || playing
  })
  ui.sources.forEach((input) => {
    input.disabled = busy
  })
  ui.pitchMode.disabled = busy || playing
  ui.reanalyze.disabled = busy || playing || !recording
  const hasNotes = buildNotes(frames, mode, pitchMode, duration).length > 0
  ui.play.disabled = !recording || busy || (source === 'piano' && !hasNotes)
  ui.play.textContent =
    phase === 'loading'
      ? '■ 読み込みを中止'
      : phase === 'playing'
        ? '■ 再生を止める'
        : '▶ 再生する'
  ui.seek.disabled = busy || !recording || playing
  ui.seek.max = String(duration)
  ui.review.hidden =
    !recording || phase === 'recording' || phase === 'requesting'
  scorePanel.update(recording && !busy ? frames : null, duration, mode)
  ui.empty.hidden =
    frames.length > 0 || phase === 'recording' || phase === 'analyzing'
  ui.stateDot.classList.toggle('recording', phase === 'recording')
  ui.phase.textContent = {
    idle: '録音前',
    requesting: 'マイク準備',
    recording: '録音中・暫定',
    analyzing: '再解析中',
    ready: '録音済み',
    loading: '音源読込中',
    playing: '再生中',
  }[phase]
  ui.duration.textContent = `${formatTime(duration)} / 1:00`
  ui.pitchHelp.textContent =
    pitchMode === 'continuous'
      ? '通常の鍵盤では出せない中間音も使い、しゃくりや細かな揺れを残すピアノ風再生です。'
      : '近くの半音へ丸めます。発声のタイミングと休符はそのままです。'
  draw()
}
/** 軌跡の表示は解析データを読むだけで、記録を進めない。 */
function draw(): void {
  const range = ranges[ui.range.value]
  drawTimeline(
    ui.canvas,
    frames,
    duration,
    cursor,
    range,
    phase === 'recording',
  )
  ui.position.textContent = formatTime(cursor)
  ui.seek.value = String(cursor)
  const voiced = frames.filter(
    (frame) => frame.state === 'voiced' && frame.midi !== null,
  )
  const current =
    phase === 'recording'
      ? frames.at(-1)
      : frames.find((frame) => frame.t >= cursor)
  if (current?.state === 'voiced' && current.midi !== null) {
    const cents = Math.round((current.midi - Math.round(current.midi)) * 100)
    ui.summary.textContent = `${noteLabel(current.midi)} ${cents >= 0 ? '+' : ''}${cents} cents${phase === 'recording' ? ' · 暫定' : ''}`
  } else
    ui.summary.textContent =
      duration > 0
        ? voiced.length
          ? '音程のない区間・判定できない区間は空白です'
          : '有効な音程をまだ検出していません'
        : 'まだ録音していません'
  const outside = voiced.some(
    (frame) => frame.midi! < range.min || frame.midi! > range.max,
  )
  ui.rangeNotice.textContent = outside
    ? '表示音域外の音があります。音域を切り替えられます。'
    : ''
}
/** 再生時計だけを描画フレームで追跡する。 */
function animate(): void {
  if (phase !== 'playing' && phase !== 'recording') return
  if (phase === 'playing') cursor = player.position()
  draw()
  frameId = requestAnimationFrame(animate)
}
/** 再生予約や読み込みを無効化し、マイクへの混入を防ぐ。 */
function stopPlayback(): void {
  revision++
  cursor = phase === 'playing' ? player.position() : cursor
  player.stop()
  cancelAnimationFrame(frameId)
  if (phase === 'playing' || phase === 'loading')
    phase = recording ? 'ready' : 'idle'
}
/** 一操作でマイク取得・PCM録音・ライブ解析を開始する。 */
async function startRecording(): Promise<void> {
  stopPlayback()
  const token = ++revision
  phase = 'requesting'
  status(
    'マイクの使用を許可してください。開始後の約0.3秒は静かにしてください。',
  )
  const session = new CaptureSession(mode, {
    onFrames: (next) => {
      if (capture === session && phase === 'recording') frames.push(...next)
    },
    onDuration: (seconds) => {
      if (capture !== session || phase !== 'recording') return
      duration = seconds
      cursor = seconds
      ui.duration.textContent = `${formatTime(duration)} / 1:00`
      if (seconds > 0.35)
        status('録音中です。声を出してください。ライブ表示は暫定の音程です。')
    },
    onAutoStop: () => {
      if (capture === session)
        void finishRecording('60秒に達したため録音を停止しました。')
    },
    onFailure: (error) => {
      if (capture !== session) return
      capture = null
      revision++
      session.cancel()
      cancelAnimationFrame(frameId)
      phase = recording ? 'ready' : 'idle'
      if (recording) {
        frames = recording.frames
        duration = recording.samples.length / recording.sampleRate
      } else {
        frames = []
        duration = 0
      }
      cursor = 0
      status(
        `録音を停止しました。${error.message} もう一度録音できます。`,
        true,
      )
      sync()
    },
  })
  capture = session
  sync()
  try {
    await session.start()
    if (token !== revision || capture !== session) {
      session.cancel()
      return
    }
    recording = null
    frames = []
    duration = 0
    cursor = 0
    phase = 'recording'
    sync()
    animate()
  } catch (error) {
    if (token !== revision) return
    session.cancel()
    capture = null
    phase = recording ? 'ready' : 'idle'
    status(
      error instanceof Error
        ? error.message
        : 'マイクを開始できません。権限と接続を確認してください。',
      true,
    )
    sync()
  }
}
/** Workletの最終PCMを回収し、停止後に前後関係を含む再解析を待つ。 */
async function finishRecording(
  message = '録音しました。元の声とピアノを聴き比べられます。',
): Promise<void> {
  if (!capture || phase !== 'recording') return
  const session = capture
  const token = ++revision
  phase = 'analyzing'
  cancelAnimationFrame(frameId)
  status('元音声から音程を見直しています。')
  sync()
  try {
    const result = await session.stop()
    if (token !== revision) return
    capture = null
    recording = result
    frames = result.frames
    duration = result.samples.length / result.sampleRate
    cursor = 0
    phase = 'ready'
    const setting = (value: boolean | undefined) =>
      value === undefined ? '未報告' : value ? '有効' : '無効'
    ui.micSettings.textContent = `実際の入力: ${result.sampleRate} Hz / PCM mono。ノイズ抑制 ${setting(result.settings.noiseSuppression)}・エコー抑制 ${setting(result.settings.echoCancellation)}・自動音量 ${setting(result.settings.autoGainControl)}。ブラウザの報告値です。`
    status(
      buildNotes(frames, mode, pitchMode, duration).length > 0
        ? message
        : '録音しましたがピアノにできる持続した音程が見つかりませんでした。元の声は再生できます。静かな場所で近くから録音してみてください。',
    )
    sync()
  } catch (error) {
    if (token !== revision) return
    session.cancel()
    capture = null
    phase = 'idle'
    frames = []
    duration = 0
    cursor = 0
    status(
      error instanceof Error
        ? error.message
        : '録音の処理に失敗しました。もう一度録音できます。',
      true,
    )
    sync()
  }
}
/** 元PCMを保持したまま、現在の歌/話し声設定で派生結果を作り直す。 */
async function analyzeAgain(): Promise<void> {
  if (!recording) return
  stopPlayback()
  const token = ++revision
  phase = 'analyzing'
  status('保持している元音声を再解析しています。')
  sync()
  try {
    const next = await reanalyze(recording.samples, recording.sampleRate, mode)
    if (token !== revision) return
    recording.frames = next
    frames = next
    cursor = 0
    phase = 'ready'
    status('再解析しました。元の声と録音時刻は変わりません。')
    sync()
  } catch (error) {
    if (token !== revision) return
    phase = 'ready'
    status(
      error instanceof Error
        ? error.message
        : '再解析に失敗しました。再試行できます。',
      true,
    )
    sync()
  }
}
ui.record.addEventListener('click', () => {
  if (phase === 'requesting') {
    revision++
    capture?.cancel()
    capture = null
    phase = recording ? 'ready' : 'idle'
    status('マイク準備をキャンセルしました。')
    sync()
  } else if (phase === 'recording') void finishRecording()
  else if (phase !== 'analyzing') void startRecording()
})
ui.play.addEventListener('click', async () => {
  if (phase === 'playing' || phase === 'loading') {
    stopPlayback()
    status('再生を停止しました。')
    sync()
    return
  }
  if (!recording || phase !== 'ready') return
  const token = ++revision
  phase = 'loading'
  status(
    source === 'piano'
      ? 'ピアノ音源を準備しています。'
      : '元の声を準備しています。',
  )
  sync()
  try {
    const notes =
      source === 'piano' ? buildNotes(frames, mode, pitchMode, duration) : null
    if (notes && !notes.length)
      throw new Error(
        'ピアノにできる音程がありません。元の声を選ぶか、もう一度録音してください。',
      )
    const started = await player.play(
      recording.samples,
      recording.sampleRate,
      notes,
      cursor >= duration - 0.02 ? 0 : cursor,
    )
    if (token !== revision || !started) return
    phase = 'playing'
    status(
      source === 'original'
        ? '元の声を再生しています。'
        : pitchMode === 'continuous'
          ? 'ズレを残すピアノ風再生です。'
          : '鍵盤に丸めたピアノを再生しています。',
    )
    sync()
    animate()
  } catch (error) {
    if (token !== revision) return
    player.stop()
    phase = 'ready'
    status(
      `${error instanceof Error ? error.message : '再生できませんでした。'} 再生ボタンで再試行できます。`,
      true,
    )
    sync()
  }
})
player.onEnded = () => {
  phase = recording ? 'ready' : 'idle'
  cursor = duration
  cancelAnimationFrame(frameId)
  status('再生が終わりました。別の音に切り替えて聴き比べられます。')
  sync()
}
player.onInterrupted = () => {
  stopPlayback()
  status('音声再生が中断されました。再生ボタンで再開できます。')
  sync()
}
player.onStatus = (state) => {
  ui.pianoStatus.textContent = {
    idle: 'ピアノ未読込',
    loading: 'ピアノ音源を外部サイトから読み込んでいます…',
    ready: 'ピアノ音源を読み込みました。',
    error: '音源の読み込みを完了できませんでした。再生ボタンで再試行できます。',
  }[state]
}
ui.sources.forEach((input) =>
  input.addEventListener('change', () => {
    stopPlayback()
    source = input.value as typeof source
    cursor = 0
    status(
      source === 'original'
        ? '元の声を選びました。再生ボタンで聴けます。'
        : buildNotes(frames, mode, pitchMode, duration).length > 0
          ? 'ピアノを選びました。再生ボタンで聴けます。'
          : 'ピアノにできる持続した音程がありません。元の声は再生できます。',
    )
    sync()
  }),
)
ui.modes.forEach((input) =>
  input.addEventListener('change', () => {
    mode = input.value as AnalysisMode
    pitchMode = mode === 'song' ? 'continuous' : 'rounded'
    ui.pitchMode.value = pitchMode
    if (recording) void analyzeAgain()
    else {
      status(
        `${mode === 'song' ? '歌声' : '話し声'}を選んでいます。最大60秒まで録音できます。`,
      )
      sync()
    }
  }),
)
ui.pitchMode.addEventListener('change', () => {
  pitchMode = ui.pitchMode.value as PitchMode
  sync()
})
ui.reanalyze.addEventListener('click', () => {
  void analyzeAgain()
})
ui.range.addEventListener('change', draw)
ui.seek.addEventListener('input', () => {
  cursor = Number(ui.seek.value)
  draw()
})
new ResizeObserver(draw).observe(ui.canvas)
/** 背景へ移った録音は停止。許可待ちはキャンセルし、復帰時に自動録音しない。 */
function interrupt(): void {
  if (phase === 'recording')
    void finishRecording('画面を離れたため録音を停止しました。')
  else if (phase === 'requesting') {
    revision++
    capture?.cancel()
    capture = null
    phase = recording ? 'ready' : 'idle'
    status('画面を離れたためマイク準備をキャンセルしました。')
    sync()
  } else if (phase === 'playing' || phase === 'loading') {
    stopPlayback()
    status('画面を離れたため再生を停止しました。')
    sync()
  }
}
document.addEventListener('visibilitychange', () => {
  if (document.hidden) interrupt()
})
window.addEventListener('pagehide', () => {
  revision++
  capture?.cancel()
  capture = null
  player.dispose()
  cancelAnimationFrame(frameId)
})
sync()
