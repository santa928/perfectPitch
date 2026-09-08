import type { AnalysisMode, PitchFrame } from '../analysis/pipeline.ts'
import { buildNotes } from '../analysis/notes.ts'
import { buildScore, scorePpq } from '../notation/score.ts'
import type { Score } from '../notation/score.ts'
import { scoreToPiano } from '../notation/score-playback.ts'
import { extractMelody, suggestTempo } from '../analysis/melody.ts'
import type { PianoNote } from '../analysis/notes.ts'
import { VoicePlayer } from '../audio/player.ts'
import { ScoreEditor } from '../notation/score-editor.ts'
import { mountScoreEditor } from './score-editor-panel.ts'
import { mountTranscriptionPanel, type TranscriptionInput } from './transcription-panel.ts'

/** 同じScoreを表示とピアノへ渡す。譜面の拍時計は原音の秒時計とは独立させる。 */
export function mountScorePanel(host: HTMLElement, callbacks: { onPlaybackStart?: () => void } = {}) {
  host.innerHTML = `
    <details id="scoreDetails" class="score-details">
      <summary>楽譜とドレミを見る <span>推定</span></summary>
      <div class="score-body">
        <div class="score-heading"><h2>あなたの声の楽譜</h2><label>テンポ <input id="scoreTempo" type="number" min="40" max="240" step="1" value="120" inputmode="numeric" aria-describedby="scoreHelp"> BPM</label></div>
        <p id="scoreHelp">4/4拍子・最短128分音符までの推定です。検出済みの別発音と休符を保って拍へ整えます。テンポを指定して音符の長さを推定します。手直しした後は音符の長さを保って演奏速度を変えます。元の声と上のピアノ再生は変わりません。</p>
        <p id="scoreTempoHint"></p>
        <div id="transcriptionPanel" hidden></div>
        <div class="score-playback"><button id="scorePlay" type="button" class="play-button" disabled>▶ 譜面どおりに聴く</button><p id="scorePlaybackStatus" role="status" aria-live="polite">鼻歌の揺れを音符にまとめ、五線譜と同じ音程・長さで聴けます。</p></div>
        <p class="score-legend">カタカナは固定ド（C＝ド）。ド4が中央のド、数字はオクターブです。半音は♯で表します。線で繋いだ同じ音は、続けて伸ばす音です。</p>
        <p id="scoreStatus" role="status" aria-live="polite"></p>
        <div id="scoreMeasures" class="score-measures"></div>
        <div class="score-navigation"><button id="scorePrevious" type="button">前の小節</button><span id="scorePage"></span><button id="scoreNext" type="button">次の小節</button></div>
        <div id="scoreEditor"></div>
        <p class="score-limit">検出できなかった声は休符になります。短い音や揺れ、話し声のリズムは正確に楽譜化できないことがあります。最後の小節は休符で埋めています。長い小節は横にスクロールできます。</p>
        <p class="score-credits">記譜: <a href="./licenses/VexFlow.txt">VexFlow（MIT）</a> · フォント: <a href="./licenses/Bravura.txt">Bravura</a> / <a href="./licenses/Academico.txt">Academico</a>（SIL OFL 1.1）</p>
      </div>
    </details>`
  const details = host.querySelector<HTMLDetailsElement>('#scoreDetails')!
  const tempo = host.querySelector<HTMLInputElement>('#scoreTempo')!
  const tempoHint = host.querySelector<HTMLElement>('#scoreTempoHint')!
  const play = host.querySelector<HTMLButtonElement>('#scorePlay')!
  const playbackStatus = host.querySelector<HTMLElement>('#scorePlaybackStatus')!
  const status = host.querySelector<HTMLElement>('#scoreStatus')!
  const measures = host.querySelector<HTMLElement>('#scoreMeasures')!
  const previous = host.querySelector<HTMLButtonElement>('#scorePrevious')!
  const next = host.querySelector<HTMLButtonElement>('#scoreNext')!
  const pageLabel = host.querySelector<HTMLElement>('#scorePage')!
  let frames: PitchFrame[] | null = null
  let duration = 0
  let mode: AnalysisMode = 'song'
  let page = 0
  let generation = 0
  let notes: PianoNote[] = []
  let originalNotes: PianoNote[] = []
  let variant: 'original' | 'model' = 'original'
  const variantEditors = new Map<string, ScoreEditor>()
  let score: Score | null = null
  let editor: ScoreEditor | null = null
  let automaticTempoHint = ''
  let playbackGeneration = 0
  let playbackPhase: 'idle' | 'loading' | 'playing' = 'idle'
  const player = new VoicePlayer()
  const perPage = 4
  const transcriptionPanel = mountTranscriptionPanel(host.querySelector<HTMLElement>('#transcriptionPanel')!, {
    onResult: alternate => {
      stop()
      if (editor) variantEditors.set(variant, editor)
      variant = alternate ? 'model' : 'original'
      notes = alternate ?? originalNotes
      editor = variantEditors.get(variant) ?? null
      suggestForNotes()
      if (editor) tempo.value = String(editor.bpm)
      updateTempoHelp()
      page = 0
      void render()
    },
  })
  const editorPanel = mountScoreEditor(host.querySelector<HTMLElement>('#scoreEditor')!, {
    editor: () => editor,
    onChange: () => {
      stop()
      if (editor) tempo.value = String(editor.bpm)
      updateTempoHelp()
      void render()
    },
    onSelect: tick => { page = Math.floor(tick / ((editor?.ppq ?? 480) * 4) / perPage); void render() },
  })
  /** 手直しした音符の音価はテンポ入力で再推定しないことを明示する。 */
  function updateTempoHelp(): void {
    tempoHint.textContent = editor?.modified ? '編集した音符の長さを保ち、テンポだけ変えて演奏します。自動推定へ戻すと音価を再推定できます。' : automaticTempoHint
  }
  /** 現在の音符列の候補と仮値を分け、推定ごとにテンポを案内する。 */
  function suggestForNotes(): void {
    const suggestion = suggestTempo(notes)
    tempo.value = String(suggestion.reliable ? suggestion.bpm : 120)
    automaticTempoHint = suggestion.reliable
      ? `テンポ候補 ${suggestion.bpm} BPM${suggestion.alternatives.length ? `（別の候補 ${suggestion.alternatives.join(' / ')}）` : ''}。拍の取り方は一意に決まらないため、聴いて調整してください。`
      : '自動テンポは未確定です。初期値は仮の120 BPMです。音符が少ない、または拍が揃わないため推定できません。聴いて調整してください。'
    updateTempoHelp()
  }
  /** 再生ボタンを実際の譜面・読み込み状態と同期する。 */
  function syncPlayback(): void {
    const hasNotes = Boolean(score && scoreToPiano(score).notes.length)
    play.disabled = playbackPhase === 'idle' && (!hasNotes || host.hidden || !tempo.validity.valid)
    if (playbackPhase === 'idle' && score && !hasNotes)
      playbackStatus.textContent = score.measures.length
        ? '再生できる音符がありません。「音符を直す」で原音符の案内を確認し、音符を追加できます。'
        : '再生できる音符がありません。元の声を聴き直せます。'
    else if (playbackPhase === 'idle' && hasNotes && playbackStatus.textContent?.startsWith('再生できる音符がありません'))
      playbackStatus.textContent = '五線譜にある音符をピアノで聴けます。原音符の要確認事項は「音符を直す」で確認してください。'
    play.textContent = playbackPhase === 'loading' ? '■ 譜面音源の読み込みを中止' : playbackPhase === 'playing' ? '■ 譜面再生を止める' : '▶ 譜面どおりに聴く'
  }
  /** 原音再生、録音、設定変更、閉じる操作で予約と遅い応答を無効化する。 */
  function stop(): void {
    const active = playbackPhase !== 'idle'
    playbackGeneration++
    player.stop()
    playbackPhase = 'idle'
    if (active) playbackStatus.textContent = '譜面の再生を停止しました。'
    syncPlayback()
  }
  play.addEventListener('click', async () => {
    if (playbackPhase !== 'idle') { stop(); return }
    if (!score || !tempo.validity.valid) return
    const result = scoreToPiano(score)
    if (!result.notes.length) { syncPlayback(); return }
    callbacks.onPlaybackStart?.()
    const token = ++playbackGeneration
    playbackPhase = 'loading'
    playbackStatus.textContent = '譜面のピアノ音源を準備しています。'
    syncPlayback()
    try {
      const started = await player.play(new Float32Array(0), 48000, result.notes, 0, result.duration)
      if (token !== playbackGeneration || !started) return
      playbackPhase = 'playing'
      playbackStatus.textContent = '譜面どおりのピアノを再生しています。元の声とは別のテンポで、最後の小節まで聴けます。'
    } catch (error) {
      if (token !== playbackGeneration) return
      playbackPhase = 'idle'
      playbackStatus.textContent = `${error instanceof Error ? error.message : '譜面を再生できませんでした。'} ボタンで再試行できます。`
    }
    syncPlayback()
  })
  player.onEnded = () => {
    playbackPhase = 'idle'
    playbackStatus.textContent = '譜面の再生が終わりました。テンポを調整して聴き直せます。'
    syncPlayback()
  }
  player.onInterrupted = () => { stop(); playbackStatus.textContent = '譜面の再生が中断されました。ボタンで再試行できます。' }
  /** 非同期ロード中の録り直し・再解析・設定変更は世代番号で破棄する。 */
  async function render(): Promise<void> {
    const token = ++generation
    measures.replaceChildren()
    previous.disabled = next.disabled = true
    pageLabel.textContent = ''
    if (!frames || !details.open || host.hidden) { syncPlayback(); return }
    if (!tempo.validity.valid || !Number.isFinite(tempo.valueAsNumber)) {
      score = null
      editorPanel.setEnabled(false)
      syncPlayback()
      status.textContent = 'テンポは40〜240の整数で入力してください。'
      return
    }
    if (!editor) editor = new ScoreEditor(buildScore(notes, duration, tempo.valueAsNumber))
    score = editor.score
    editorPanel.setEnabled(true)
    syncPlayback()
    if (!score.measures.length) {
      status.textContent = score.omittedNotes
        ? `配置できない原音符が${score.omittedNotes}個あります。「音符を直す」で対象と理由を確認してください。`
        : '楽譜にできる音程を検出していません。元の声は聴き直せます。'
      return
    }
    page = Math.min(page, Math.ceil(score.measures.length / perPage) - 1)
    const start = page * perPage
    const end = Math.min(start + perPage, score.measures.length)
    status.textContent = '楽譜を準備しています…'
    try {
      const { renderMeasures } = await import('./score-renderer.ts')
      if (token !== generation) return
      // 別ホストへ描いてから反映し、フォント待ち中の古い結果を表示しない。
      const staging = document.createElement('div')
      staging.className = 'score-measures score-staging'
      staging.style.width = `${measures.clientWidth}px`
      host.append(staging)
      try {
        await renderMeasures(staging, score.measures.slice(start, end), start, { onSelect: tick => editorPanel.select(tick), ppq: scorePpq(score) })
        if (token !== generation) return
        measures.replaceChildren(...staging.childNodes)
      } finally { staging.remove() }
      status.textContent = `${editor?.modified ? '手直しした楽譜です。' : ''}最初の検出音（録音${score.origin.toFixed(2)}秒）を1拍目にしています。${score.issues?.length ? '要確認の原音符があります。' : ''}${score.omittedNotes ? `原音符${score.omittedNotes}個は未配置です。「音符を直す」で対象と理由を確認してください。` : ''}`
      pageLabel.textContent = `${start + 1}〜${end} / ${score.measures.length}小節`
      previous.disabled = page === 0
      next.disabled = end === score.measures.length
    } catch {
      if (token !== generation) return
      status.textContent = '楽譜を表示できませんでした。録音と再生は引き続き使えます。閉じて開いても表示されない場合はページの再読み込みが必要です（録音は消えます）。'
    }
  }
  details.addEventListener('toggle', () => { if (!details.open) stop(); void render() })
  tempo.addEventListener('input', () => {
    stop(); page = 0
    if (tempo.validity.valid && Number.isFinite(tempo.valueAsNumber)) {
      if (editor?.modified) editor.setTempo(tempo.valueAsNumber)
      else editor = new ScoreEditor(buildScore(notes, duration, tempo.valueAsNumber))
      updateTempoHelp()
    }
    void render()
  })
  previous.addEventListener('click', () => { page--; void render() })
  next.addEventListener('click', () => { page++; void render() })
  let width = 0
  new ResizeObserver(([entry]) => {
    if (Math.abs(entry.contentRect.width - width) < 1) return
    width = entry.contentRect.width
    if (details.open) void render()
  }).observe(measures)
  return {
    stop,
    /** ページを離れたときに譜面専用の音声資源を解放する。 */
    dispose(): void { stop(); transcriptionPanel.cancel(); player.dispose() },
    /** ready時のフレーム参照が変わった場合だけ派生データを更新する。 */
    update(nextFrames: PitchFrame[] | null, nextDuration: number, nextMode: AnalysisMode, available = true,
      input: TranscriptionInput | null = null): void {
      const wasHidden = host.hidden
      const changed = frames !== nextFrames || duration !== nextDuration || mode !== nextMode
      frames = nextFrames
      duration = nextDuration
      mode = nextMode
      host.hidden = frames === null || !available
      transcriptionPanel.update(mode === 'song' ? input : null, available)
      if (host.hidden) stop()
      if (changed) {
        stop()
        transcriptionPanel.reset()
        score = null
        editor = null
        variantEditors.clear()
        variant = 'original'
        editorPanel.clear()
        notes = frames ? mode === 'song' ? extractMelody(frames, duration) : buildNotes(frames, mode, 'rounded', duration) : []
        originalNotes = notes
        suggestForNotes()
        playbackStatus.textContent = mode === 'song'
          ? '鼻歌の揺れを音符にまとめ、五線譜と同じ音程・長さで聴けます。推定違いは残るため元の声と聴き比べてください。'
          : '話し声を鍵盤と音符の長さに丸めた推定です。五線譜と同じ内容で聴けます。'
        page = 0
        void render()
      } else if (wasHidden !== host.hidden) void render()
    },
  }
}
