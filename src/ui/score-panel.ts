import type { AnalysisMode, PitchFrame } from '../analysis/pipeline.ts'
import { buildNotes } from '../analysis/notes.ts'
import { buildScore } from '../notation/score.ts'

/** 録音後だけ開ける記譜パネル。解析と再生の設定を変更しない。 */
export function mountScorePanel(host: HTMLElement) {
  host.innerHTML = `
    <details id="scoreDetails" class="score-details">
      <summary>楽譜とドレミを見る <span>推定</span></summary>
      <div class="score-body">
        <div class="score-heading"><h2>あなたの声の楽譜</h2><label>テンポ <input id="scoreTempo" type="number" min="40" max="240" step="1" value="120" inputmode="numeric" aria-describedby="scoreHelp"> BPM</label></div>
        <p id="scoreHelp">4/4拍子・16分音符単位の推定です。初期テンポ120は仮の値なので、歌に合わせて調整してください。楽譜の設定を変えても、元の声やピアノの速さは変わりません。</p>
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
  const perPage = 4
  /** 非同期ロード中の録り直し・再解析・設定変更は世代番号で破棄する。 */
  async function render(): Promise<void> {
    const token = ++generation
    measures.replaceChildren()
    previous.disabled = next.disabled = true
    pageLabel.textContent = ''
    if (!frames || !details.open || host.hidden) return
    if (!tempo.validity.valid || !Number.isFinite(tempo.valueAsNumber)) {
      status.textContent = 'テンポは40〜240の整数で入力してください。'
      return
    }
    const score = buildScore(buildNotes(frames, mode, 'rounded', duration), duration, tempo.valueAsNumber)
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
  details.addEventListener('toggle', () => { void render() })
  tempo.addEventListener('input', () => { page = 0; void render() })
  previous.addEventListener('click', () => { page--; void render() })
  next.addEventListener('click', () => { page++; void render() })
  let width = 0
  new ResizeObserver(([entry]) => {
    if (Math.abs(entry.contentRect.width - width) < 1) return
    width = entry.contentRect.width
    if (details.open) void render()
  }).observe(measures)
  return {
    /** ready時のフレーム参照が変わった場合だけ派生データを更新する。 */
    update(nextFrames: PitchFrame[] | null, nextDuration: number, nextMode: AnalysisMode): void {
      const changed = frames !== nextFrames || duration !== nextDuration || mode !== nextMode
      frames = nextFrames
      duration = nextDuration
      mode = nextMode
      host.hidden = frames === null
      if (changed) { page = 0; void render() }
    },
  }
}
