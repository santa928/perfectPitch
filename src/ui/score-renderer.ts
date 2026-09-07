import { Accidental, Annotation, Beam, Formatter, Renderer, Stave, StaveNote, StaveTie, Voice } from 'vexflow/bravura'
import { spellPitch } from '../notation/score.ts'
import type { ScoreEvent } from '../notation/score.ts'

/** 各小節を独立したSVGへ記譜する。フォントは同梱版を使い外部通信しない。 */
export async function renderMeasures(host: HTMLElement, measures: ScoreEvent[][], firstMeasure: number,
  options: { onSelect?: (tick: number) => void } = {}): Promise<void> {
  await document.fonts.ready
  // FontFace.load()が開始済みであることを待ち、豆腐文字での寸法計算を防ぐ。
  await document.fonts.load('16px Bravura')
  host.replaceChildren()
  for (const [index, events] of measures.entries()) {
    const figure = document.createElement('figure')
    figure.className = 'score-measure'
    const caption = document.createElement('figcaption')
    caption.textContent = `${firstMeasure + index + 1}小節`
    const scroll = document.createElement('div')
    scroll.className = 'score-scroll'
    scroll.tabIndex = 0
    scroll.setAttribute('role', 'region')
    scroll.setAttribute('aria-label', `${caption.textContent}の楽譜。横に長い場合はスクロールできます`)
    figure.append(caption, scroll)
    host.append(figure)
    const pitches = events.flatMap((event) => event.midi === null ? [] : [event.midi]).sort((a, b) => a - b)
    const clef = (pitches[Math.floor(pitches.length / 2)] ?? 60) < 60 ? 'bass' : 'treble'
    const renderer = new Renderer(scroll, Renderer.Backends.SVG)
    renderer.resize(800, 350)
    const context = renderer.getContext()
    context.setFillStyle('#20334c').setStrokeStyle('#20334c')
    const accidentals = new Map<string, string>()
    const notes = events.map((event) => {
      const pitch = event.midi === null ? null : spellPitch(event.midi)
      const note = new StaveNote({
        keys: [pitch?.key ?? (clef === 'treble' ? 'b/4' : 'd/3')],
        duration: `${16 / event.ticks}${pitch ? '' : 'r'}`,
        clef,
        autoStem: true,
      })
      if (pitch) {
        const naturalKey = pitch.key.replace('#', '')
        const previous = accidentals.get(naturalKey) ?? ''
        if (pitch.accidental !== previous)
          note.addModifier(new Accidental(pitch.accidental || 'n'))
        accidentals.set(naturalKey, pitch.accidental)
        note.addModifier(new Annotation(pitch.label)
          .setFont('system-ui', 12)
          .setVerticalJustification(Annotation.VerticalJustify.BOTTOM))
      }
      return note
    })
    const voice = new Voice({ numBeats: 4, beatValue: 4 }).addTickables(notes)
    const formatter = new Formatter().joinVoices([voice])
    const minWidth = formatter.preCalculateMinTotalWidth([voice])
    // 音符とカタカナの実測必要幅を下限にする。狭い画面は文字を潰さず小節内で横スクロール。
    const width = Math.max(scroll.clientWidth, Math.ceil(minWidth + 155 + notes.length * 10))
    const stave = new Stave(12, 90, width - 24).addClef(clef).addTimeSignature('4/4')
    stave.setContext(context).draw()
    const beams = Beam.generateBeams(notes)
    formatter.formatToStave([voice], stave)
    voice.draw(context, stave)
    beams.forEach((beam) => beam.setContext(context).draw())
    for (const [i, event] of events.entries()) {
      if (event.tieIn && i === 0)
        new StaveTie({ lastNote: notes[i], firstIndexes: [0], lastIndexes: [0] }).setContext(context).draw()
      if (event.tieOut)
        new StaveTie({ firstNote: notes[i], lastNote: notes[i + 1], firstIndexes: [0], lastIndexes: [0] }).setContext(context).draw()
    }
    const svg = scroll.querySelector('svg')!
    // VexFlowの注釈は音符ごとに上下するため、広い音域では五線と重なる。
    // 横位置・必要幅はFormatterに任せ、全注釈を描画済み音符の下の同じ行へ揃える。
    const labels = Array.from(svg.querySelectorAll<SVGGElement>('.vf-annotation'))
    labels.forEach((label) => label.remove())
    // 音楽フォントのgetBBoxには大きなem余白があるので、音符/符幹の座標から行位置を求める。
    const musicBottom = Math.max(stave.getYForLine(4), ...notes.flatMap((note) => {
      const extents = note.hasStem() ? note.getStemExtents() : null
      return [...note.getYs(), ...(extents ? [extents.topY, extents.baseY] : [])]
    }))
    const labelTop = musicBottom + 26
    for (const label of labels) {
      svg.append(label)
      label.setAttribute('transform', `translate(0 ${labelTop - label.getBBox().y})`)
    }
    svg.setAttribute('role', options.onSelect ? 'group' : 'img')
    svg.setAttribute('aria-label', `${caption.textContent}。${events.map((event) => event.midi === null ? '休符' : `${event.tieIn ? '継続' : ''}${spellPitch(event.midi).label}`).join('、')}`)
    if (options.onSelect) {
      const groups = svg.querySelectorAll<SVGGElement>('.vf-stavenote')
      groups.forEach((group, i) => {
        const event = events[i]
        if (!event || event.midi === null) return
        group.classList.add('selectable-note')
        group.setAttribute('role', 'button')
        group.setAttribute('tabindex', '0')
        group.setAttribute('aria-label', `${caption.textContent} ${event.tick % 16 / 4 + 1}拍 ${spellPitch(event.midi).label}の音符を直す`)
        group.addEventListener('click', () => options.onSelect?.(event.tick))
        group.addEventListener('keydown', eventKey => {
          if (eventKey.key === 'Enter' || eventKey.key === ' ') { eventKey.preventDefault(); options.onSelect?.(event.tick) }
        })
      })
    }
    // 加線・低音の注釈も含めた描画結果から上下の余白を確保する。
    const bounds = svg.getBBox()
    const left = Math.min(0, bounds.x - 12)
    const top = bounds.y - 12
    const bottom = bounds.y + bounds.height + 20
    const fullWidth = Math.max(width, bounds.x + bounds.width + 12) - left
    renderer.resize(fullWidth, bottom - top)
    svg.setAttribute('viewBox', `${left} ${top} ${fullWidth} ${bottom - top}`)
  }
}
