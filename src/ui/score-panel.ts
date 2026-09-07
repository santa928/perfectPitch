import type { AnalysisMode, PitchFrame } from '../analysis/pipeline.ts'
import { buildNotes } from '../analysis/notes.ts'
import { buildScore } from '../notation/score.ts'
import type { Score } from '../notation/score.ts'
import { scoreToPiano } from '../notation/score-playback.ts'
import { extractMelody, suggestTempo } from '../analysis/melody.ts'
import type { PianoNote } from '../analysis/notes.ts'
import { VoicePlayer } from '../audio/player.ts'

/** 同じScoreを表示とピアノへ渡す。譜面の拍時計は原音の秒時計とは独立させる。 */
export function mountScorePanel(host: HTMLElement, callbacks: { onPlaybackStart?: () => void } = {}) {
  host.innerHTML = `
    <details id="scoreDetails" class="score-details">
      <summary>楽譜とドレミを見る <span>推定</span></summary>
      <div class="score-body">
        <div class="score-heading"><h2>あなたの声の楽譜</h2><label>テンポ <input id="scoreTempo" type="number" min="40" max="240" step="1" value="120" inputmode="numeric" aria-describedby="scoreHelp"> BPM</label></div>
        <p id="scoreHelp">4/4拍子・16分音符単位の推定です。テンポを調整すると、この楽譜と「譜面どおりに聴く」が一緒に変わります。元の声と上のピアノ再生は変わりません。</p>
        <p id="scoreTempoHint"></p>
        <div class="score-playback"><button id="scorePlay" type="button" class="play-button" disabled>▶ 譜面どおりに聴く</button><p id="scorePlaybackStatus" role="status" aria-live="polite">鼻歌の揺れを音符にまとめ、五線譜と同じ音程・長さで聴けます。</p></div>
        <p class="score-legend">カタカナは固定ド（C＝ド）。ド4が中央のド、数字はオクターブです。半音は♯で表します。線で繋いだ同じ音は、続けて伸ばす音です。</p>
        <p id="scoreStatus" role="status" aria-live="polite"></p>
        <div id="scoreMeasures" class="score-measures"></div>
        <div class="score-navigation"><button id="scorePrevious" type="button">前の小節</button><span id="scorePage"></span><button id="scoreNext" type="button">次の小節</button></div>
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
  let score: Score | null = null
  let playbackGeneration = 0
  let playbackPhase: 'idle' | 'loading' | 'playing' = 'idle'
  const player = new VoicePlayer()
  const perPage = 4
  /** 再生ボタンを実際の譜面・読み込み状態と同期する。 */
  function syncPlayback(): void {
    play.disabled = playbackPhase === 'idle' && (!score?.measures.length || host.hidden || !tempo.validity.valid)
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
    callbacks.onPlaybackStart?.()
    const token = ++playbackGeneration
    const result = scoreToPiano(score)
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
      syncPlayback()
      status.textContent = 'テンポは40〜240の整数で入力してください。'
      return
    }
    score = buildScore(notes, duration, tempo.valueAsNumber)
    syncPlayback()
    if (!score.measures.length) {
      status.textContent = score.omittedNotes
        ? `短い音${score.omittedNotes}個が16分音符単位では残らず、楽譜にできませんでした。テンポを上げるか、音を長めに録音してみてください。`
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
        await renderMeasures(staging, score.measures.slice(start, end), start)
        if (token !== generation) return
        measures.replaceChildren(...staging.childNodes)
      } finally { staging.remove() }
      status.textContent = `最初の検出音（録音${score.origin.toFixed(2)}秒）を1拍目にしています。${score.omittedNotes ? `短い音${score.omittedNotes}個は丸めにより省略されました。` : ''}`
      pageLabel.textContent = `${start + 1}〜${end} / ${score.measures.length}小節`
      previous.disabled = page === 0
      next.disabled = end === score.measures.length
    } catch {
      if (token !== generation) return
      status.textContent = '楽譜を表示できませんでした。録音と再生は引き続き使えます。閉じて開いても表示されない場合はページの再読み込みが必要です（録音は消えます）。'
    }
  }
  details.addEventListener('toggle', () => { if (!details.open) stop(); void render() })
  tempo.addEventListener('input', () => { stop(); page = 0; void render() })
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
    dispose(): void { stop(); player.dispose() },
    /** ready時のフレーム参照が変わった場合だけ派生データを更新する。 */
    update(nextFrames: PitchFrame[] | null, nextDuration: number, nextMode: AnalysisMode): void {
      const changed = frames !== nextFrames || duration !== nextDuration || mode !== nextMode
      frames = nextFrames
      duration = nextDuration
      mode = nextMode
      host.hidden = frames === null
      if (changed) {
        stop()
        score = null
        notes = frames ? mode === 'song' ? extractMelody(frames, duration) : buildNotes(frames, mode, 'rounded', duration) : []
        const suggestion = suggestTempo(notes)
        tempo.value = String(suggestion.bpm)
        tempoHint.textContent = suggestion.reliable
          ? `テンポ候補 ${suggestion.bpm} BPM${suggestion.alternatives.length ? `（別の候補 ${suggestion.alternatives.join(' / ')}）` : ''}。拍の取り方は一意に決まらないため、聴いて調整してください。`
          : 'テンポは仮の120 BPMです。音符が少ない、または拍が揃わないため推定できません。聴いて調整してください。'
        if (!suggestion.reliable) tempo.value = '120'
        playbackStatus.textContent = mode === 'song'
          ? '鼻歌の揺れを音符にまとめ、五線譜と同じ音程・長さで聴けます。推定違いは残るため元の声と聴き比べてください。'
          : '話し声を鍵盤と音符の長さに丸めた推定です。五線譜と同じ内容で聴けます。'
        page = 0
        void render()
      }
    },
  }
}
