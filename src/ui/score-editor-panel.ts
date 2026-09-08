import { spellPitch } from '../notation/score.ts'
import type { ScoreEditor } from '../notation/score-editor.ts'
import { scoreToMidi } from '../notation/midi.ts'

/** 拍単位のフォームで共通Scoreを直す。編集結果とMIDIを別データにしない。 */
export function mountScoreEditor(host: HTMLElement, callbacks: {
  editor(): ScoreEditor | null
  onChange(): void
  onSelect?(tick: number): void
}) {
  host.innerHTML = `
    <div class="score-save"><button id="saveMidi" class="text-button" type="button">MIDIを保存</button><span>音程・長さ・テンポを、楽器アプリへ。</span></div>
    <details id="scoreEditDetails"><summary>音符を直す</summary><div class="score-edit-body">
      <p>五線譜の音符を選ぶか、一覧から選んで修正できます。元の声と音程の軌跡は変わりません。</p>
      <div id="scoreSourceIssues"></div>
      <label>直す音符<select id="editNote"></select></label>
      <div class="score-edit-fields">
        <label>音程<select id="editPitch" aria-label="音程">${Array.from({ length: 88 }, (_, i) => `<option value="${i + 21}">${spellPitch(i + 21).label}</option>`).join('')}</select></label>
        <label>開始の小節<input id="editMeasure" type="number" min="1" step="1" value="1"></label>
        <label>開始の拍<input id="editBeat" type="number" min="1" max="4.75" step="0.25" value="1"></label>
        <label>長さ（拍）<input id="editLength" type="number" min="0.25" step="0.25" value="1"></label>
      </div>
      <p id="scoreEditHelp">1拍は4分音符、0.5拍は8分音符です。最短1/32拍（128分音符）ずつ調整できます。</p>
      <div class="score-edit-actions"><button id="applyNote" type="button">変更する</button><button id="removeNote" type="button">休符にする</button><button id="insertNote" type="button">休符に音符を追加</button></div>
      <div class="score-edit-actions"><button id="undoScore" type="button">元に戻す</button><button id="redoScore" type="button">やり直す</button><button id="resetScore" type="button">自動推定に戻す</button></div>
    </div></details><p id="scoreEditStatus" role="status" aria-live="polite"></p>`
  const get = <T extends HTMLElement>(id: string) => host.querySelector<T>(`#${id}`)!
  const choice = get<HTMLSelectElement>('editNote')
  const pitch = get<HTMLSelectElement>('editPitch')
  const measure = get<HTMLInputElement>('editMeasure')
  const beat = get<HTMLInputElement>('editBeat')
  const length = get<HTMLInputElement>('editLength')
  const apply = get<HTMLButtonElement>('applyNote')
  const remove = get<HTMLButtonElement>('removeNote')
  const insert = get<HTMLButtonElement>('insertNote')
  const undo = get<HTMLButtonElement>('undoScore')
  const redo = get<HTMLButtonElement>('redoScore')
  const reset = get<HTMLButtonElement>('resetScore')
  const save = get<HTMLButtonElement>('saveMidi')
  const status = get('scoreEditStatus')
  let selected: number | null = null
  let enabled = true

  /** 選択を保持し、数値・操作可否を編集モデルから更新する。 */
  function refresh(): void {
    const editor = callbacks.editor(), notes = editor?.notes ?? []
    const ppq = editor?.ppq ?? 480, bar = ppq * 4, step = editor?.beatStep ?? 1 / 32
    beat.step = length.step = String(step)
    beat.max = String(5 - step)
    length.min = String(step)
    get('scoreEditHelp').textContent = `1拍は4分音符、0.5拍は8分音符です。${step === 1 / 32 ? '最短1/32拍（128分音符）' : `${step}拍`}ずつ調整できます。`
    if (!notes.some(n => n.id === selected)) selected = notes[0]?.id ?? null
    choice.replaceChildren(...notes.map((note, i) => new Option(
      `${i + 1}. ${Math.floor(note.tick / bar) + 1}小節 ${note.tick % bar / ppq + 1}拍 · ${spellPitch(note.midi).label} · ${note.ticks / ppq}拍`, String(note.id))))
    if (selected !== null) choice.value = String(selected)
    const note = notes.find(n => n.id === selected)
    if (note) {
      pitch.value = String(note.midi)
      measure.value = String(Math.floor(note.tick / bar) + 1)
      beat.value = String(note.tick % bar / ppq + 1)
      length.value = String(note.ticks / ppq)
    }
    measure.max = String((editor?.totalTicks ?? 0) / bar)
    length.max = String((editor?.totalTicks ?? 0) / ppq)
    const score = editor?.score, issueHost = get('scoreSourceIssues')
    const wasOpen = issueHost.querySelector('details')?.open ?? false
    issueHost.replaceChildren()
    const issueDetails = document.createElement('details')
    issueDetails.open = wasOpen
    const issueSummary = document.createElement('summary')
    issueSummary.textContent = `自動変換の要確認 ${score?.issues?.length ?? 0}件：対象と理由`
    issueDetails.append(issueSummary)
    for (const issue of score?.issues ?? []) {
      const item = document.createElement('p')
      item.textContent = `自動変換の要確認: ${issue.reason} ` + issue.sourceIds.map(id => {
        const source = score?.sourceNotes?.find(n => n.sourceId === id)
        return source ? `入力${id + 1} ${Number.isFinite(source.midi) ? spellPitch(source.midi).label : '音高不正'}（原音${source.start}〜${source.end}秒）` : `入力${id + 1}`
      }).join('、')
      issueDetails.append(item)
    }
    if (score?.issues?.length) {
      const help = document.createElement('p')
      help.textContent = '原音符は保持されています。配置済み音は一覧から修正し、未配置音は開始・長さ・音程を指定して「休符に音符を追加」で補えます。ここには自動変換時の診断を残しています。'
      issueDetails.append(help)
      issueHost.append(issueDetails)
    }
    choice.disabled = apply.disabled = remove.disabled = !enabled || !note
    insert.disabled = !enabled || !editor?.totalTicks
    undo.disabled = !enabled || !editor?.canUndo
    redo.disabled = !enabled || !editor?.canRedo
    reset.disabled = !enabled || !editor?.modified
    save.disabled = !enabled || !editor || !notes.length
    for (const control of [pitch, measure, beat, length]) control.disabled = !enabled || !editor
  }
  /** 入力値をScoreの整数tickへ変換する。重複・範囲の最終検証は編集モデルに集約。 */
  function values(): { tick: number; ticks: number; midi: number } {
    if (![measure, beat, length].every(input => input.validity.valid && Number.isFinite(input.valueAsNumber)))
      throw new Error(`小節は整数、拍と長さは${callbacks.editor()?.beatStep ?? 1 / 32}拍単位で入力してください。`)
    const ppq = callbacks.editor()?.ppq ?? 480
    return { tick: (measure.valueAsNumber - 1) * ppq * 4 + (beat.valueAsNumber - 1) * ppq,
      ticks: length.valueAsNumber * ppq, midi: Number(pitch.value) }
  }
  /** 不正入力は元の音符を保持し、成功時だけ譜面と再生を更新する。 */
  function change(action: (editor: ScoreEditor) => void, message: string): void {
    const editor = callbacks.editor()
    if (!editor) return
    try {
      action(editor)
      status.textContent = message
      status.classList.remove('error')
      refresh()
      callbacks.onChange()
    } catch (error) {
      status.textContent = error instanceof Error ? error.message : '音符を変更できませんでした。'
      status.classList.add('error')
    }
  }
  choice.addEventListener('change', () => {
    selected = Number(choice.value)
    refresh()
    const note = callbacks.editor()?.notes.find(n => n.id === selected)
    if (note) callbacks.onSelect?.(note.tick)
  })
  apply.addEventListener('click', () => change(e => e.edit(selected!, values()), '音符を変更しました。五線譜・譜面再生・MIDIに反映されます。'))
  remove.addEventListener('click', () => change(e => e.remove(selected!), '選んだ音を休符にしました。「元に戻す」で戻せます。'))
  insert.addEventListener('click', () => change(e => { selected = e.insert(values()) }, '休符に音符を追加しました。'))
  undo.addEventListener('click', () => change(e => { e.undo() }, 'ひとつ前に戻しました。'))
  redo.addEventListener('click', () => change(e => { e.redo() }, '変更をやり直しました。'))
  reset.addEventListener('click', () => change(e => { e.reset() }, '自動推定に戻しました。'))
  save.addEventListener('click', () => {
    const editor = callbacks.editor()
    if (!editor) return
    try {
      const bytes = scoreToMidi(editor.score)
      const url = URL.createObjectURL(new Blob([new Uint8Array(bytes).buffer], { type: 'audio/midi' }))
      const anchor = document.createElement('a')
      anchor.href = url; anchor.download = 'perfectPitch.mid'
      document.body.append(anchor); anchor.click(); anchor.remove()
      setTimeout(() => URL.revokeObjectURL(url), 1000)
      status.textContent = 'この楽譜のMIDIを保存しました。カタカナと五線譜の画像はMIDIには含まれません。'
      status.classList.remove('error')
    } catch { status.textContent = 'MIDIを保存できませんでした。もう一度試してください。'; status.classList.add('error') }
  })
  refresh()
  return { refresh,
    /** 不正なテンポ入力中に、見えない古い譜面を編集・保存しない。 */
    setEnabled(value: boolean): void { enabled = value; refresh() },
    /** 譜面のタイを含む任意の音符片から論理音符を選択する。 */
    select(tick: number): void {
      const note = callbacks.editor()?.notes.find(n => n.tick <= tick && n.tick + n.ticks > tick)
      if (!note) return
      selected = note.id
      get<HTMLDetailsElement>('scoreEditDetails').open = true
      refresh()
      choice.focus()
    },
    /** 別の録音になった場合に古い編集メッセージを残さない。 */
    clear(): void { selected = null; status.textContent = ''; refresh() },
  }
}
