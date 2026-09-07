import type { PianoNote } from '../analysis/notes.ts'
import { transcribeMelody } from '../audio/transcription.ts'

export type TranscriptionInput = { samples: Float32Array; sampleRate: number }

/** 任意の再採譜だけを遅延ロードし、失敗・中止で直前の推定を保持する。 */
export function mountTranscriptionPanel(host: HTMLElement, callbacks: {
  onResult(notes: PianoNote[] | null): void
}) {
  host.innerHTML = `<div class="transcription-actions"><button id="transcribe" class="text-button" type="button">途切れを抑えて採譜</button><button id="cancelTranscription" class="text-button" type="button" hidden>再採譜を中止</button><label id="melodyVersionLabel" hidden>使う推定<select id="melodyVersion"><option value="original">元の推定</option><option value="model">途切れを抑えた推定</option></select></label></div>
    <p>子音や揺れを音符へまとめ直す、別の推定です。速い音・跳躍を取り違える場合があるため、元の推定と聴き比べて選べます。初回は約14 MBを読み込みます。キャッシュ状況により再取得します。音声の送信はありません。</p>
    <p id="transcriptionStatus" role="status" aria-live="polite"></p><p class="score-credits">再採譜: <a href="./licenses/BasicPitch.txt">Basic Pitch（Apache-2.0）</a> · <a href="./licenses/ONNXRuntime.txt">ONNX Runtime（MIT）</a> · <a href="./licenses/ONNXRuntime-ThirdPartyNotices.txt">第三者ライセンス</a></p>`
  const button = host.querySelector<HTMLButtonElement>('#transcribe')!
  const cancelButton = host.querySelector<HTMLButtonElement>('#cancelTranscription')!
  const choice = host.querySelector<HTMLSelectElement>('#melodyVersion')!
  const label = host.querySelector<HTMLElement>('#melodyVersionLabel')!
  const status = host.querySelector<HTMLElement>('#transcriptionStatus')!
  let input: TranscriptionInput | null = null
  let alternate: PianoNote[] | null = null
  let controller: AbortController | null = null
  let generation = 0

  /** 停止時は遅い推論結果も無効化する。 */
  function cancel(): void {
    generation++
    controller?.abort()
    controller = null
    button.disabled = !input
    choice.disabled = false
    cancelButton.hidden = true
  }
  /** 同じPCMでも再解析された場合、前の派生候補は使い回さない。 */
  function reset(): void {
    cancel(); alternate = null; label.hidden = true; button.hidden = false; choice.value = 'original'; status.textContent = ''
  }
  button.addEventListener('click', async () => {
    if (!input || controller) return
    const source = input, token = ++generation
    controller = new AbortController()
    const signal = controller.signal
    button.disabled = choice.disabled = true
    cancelButton.hidden = false
    status.textContent = '採譜の準備をしています。元の声と元の推定は保持しています。'
    status.classList.remove('error')
    try {
      const notes = await transcribeMelody(source.samples, source.sampleRate, { signal, onProgress: event => {
        if (token !== generation) return
        status.textContent = event.stage === 'loading' ? '採譜モデルを読み込んでいます。初回は少し時間がかかります。'
          : event.stage === 'notes' ? '音符のまとまりを確認しています。'
          : `音声を分析しています${event.progress === undefined ? '。' : `（${Math.floor(event.progress * 100)}%）。`}`
      } })
      if (token !== generation) return
      if (!notes.length) throw new Error('まとめ直せる音符が見つかりませんでした。元の推定を引き続き使えます。')
      alternate = notes
      button.hidden = true
      choice.value = 'model'
      label.hidden = false
      callbacks.onResult(alternate)
      status.textContent = '別の推定に切り替えました。譜面どおりに聴き、元の推定と比べられます。自動推定の誤りは残ることがあります。'
    } catch (error) {
      if (token !== generation) return
      status.textContent = `${error instanceof Error ? error.message : '再採譜できませんでした。'} 直前の結果を保持しています。もう一度試せます。`
      status.classList.add('error')
    } finally {
      if (token === generation) { controller = null; button.disabled = false; choice.disabled = false; cancelButton.hidden = true }
    }
  })
  choice.addEventListener('change', () => callbacks.onResult(choice.value === 'model' ? alternate : null))
  cancelButton.addEventListener('click', () => { cancel(); status.textContent = '再採譜を中止しました。直前の結果を保持しています。' })
  return {
    cancel,
    reset,
    /** 同じ録音はキャッシュを保持し、別の入力や録音中には古い推論を反映しない。 */
    update(next: TranscriptionInput | null, available: boolean): void {
      if (input?.samples !== next?.samples || input?.sampleRate !== next?.sampleRate) {
        reset(); input = next
      }
      if (!available && controller) { cancel(); status.textContent = '操作が切り替わったため再採譜を中止しました。' }
      host.hidden = !next || !available
      button.disabled = !next || controller !== null
    },
  }
}
