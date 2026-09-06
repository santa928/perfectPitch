import type { PitchFrame } from '../analysis/pipeline.ts'

export type PitchRange = { min: number; max: number }
const NAMES = ['C', 'C♯', 'D', 'D♯', 'E', 'F', 'F♯', 'G', 'G♯', 'A', 'A♯', 'B']
/** 鍵盤ラベルのみ整数に丸め、解析データは変更しない。 */
export function noteLabel(midi: number): string {
  const key = Math.round(midi)
  return `${NAMES[((key % 12) + 12) % 12]}${Math.floor(key / 12) - 1}`
}
/** Canvasの内側を軸ラベルと安全余白から求める。音域外は描画しない。 */
export function plotBounds(width: number, height: number) {
  return {
    left: 48,
    right: Math.max(49, width - 18),
    top: 22,
    bottom: Math.max(23, height - 30),
  }
}
/** 声の連続線と半音バーを独立描画。空白・範囲外で必ず線を分断する。 */
export function drawTimeline(
  canvas: HTMLCanvasElement,
  frames: PitchFrame[],
  duration: number,
  cursor: number,
  range: PitchRange,
  follow: boolean,
): void {
  const { width, height } = canvas.getBoundingClientRect()
  const dpr = window.devicePixelRatio || 1
  if (
    canvas.width !== Math.round(width * dpr) ||
    canvas.height !== Math.round(height * dpr)
  ) {
    canvas.width = Math.round(width * dpr)
    canvas.height = Math.round(height * dpr)
  }
  const ctx = canvas.getContext('2d')!
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
  ctx.clearRect(0, 0, width, height)
  const bounds = plotBounds(width, height)
  const span = 8
  const start = follow
    ? Math.max(0, cursor - span + 0.7)
    : Math.max(0, Math.min(cursor - span / 2, duration - span))
  const x = (t: number) =>
    bounds.left + ((t - start) / span) * (bounds.right - bounds.left)
  const y = (midi: number) =>
    bounds.bottom -
    ((midi - range.min) / (range.max - range.min)) *
      (bounds.bottom - bounds.top)
  ctx.font = '11px system-ui'
  ctx.textAlign = 'right'
  ctx.textBaseline = 'middle'
  for (let midi = range.min; midi <= range.max; midi++) {
    const isLabel = midi % 12 === 0 || midi === range.min || midi === range.max
    ctx.strokeStyle = isLabel ? '#c8d3df' : '#e9edf1'
    ctx.beginPath()
    ctx.moveTo(bounds.left, y(midi))
    ctx.lineTo(bounds.right, y(midi))
    ctx.stroke()
    if (isLabel || (range.max - range.min <= 24 && midi % 2 === 0)) {
      ctx.fillStyle = '#52647a'
      ctx.fillText(noteLabel(midi), bounds.left - 8, y(midi))
    }
  }
  ctx.textAlign = 'center'
  for (let time = Math.ceil(start); time <= start + span; time++) {
    ctx.fillStyle = '#6a7785'
    ctx.fillText(`${time}s`, x(time), height - 12)
  }
  ctx.save()
  ctx.beginPath()
  ctx.rect(
    bounds.left,
    bounds.top - 3,
    bounds.right - bounds.left,
    bounds.bottom - bounds.top + 6,
  )
  ctx.clip()
  const visible = frames.filter(
    (frame) => frame.t >= start - 0.1 && frame.t <= start + span + 0.1,
  )
  ctx.strokeStyle = '#a7c3df'
  ctx.lineWidth = 4
  for (let i = 0; i < visible.length; i++) {
    const frame = visible[i]
    if (
      frame.state !== 'voiced' ||
      frame.midi === null ||
      frame.midi < range.min ||
      frame.midi > range.max
    )
      continue
    const next = visible[i + 1]
    const end = next
      ? Math.min(next.t, frame.t + 0.02)
      : Math.min(duration, frame.t + 0.01)
    ctx.beginPath()
    ctx.moveTo(x(frame.t), y(Math.round(frame.midi)))
    ctx.lineTo(x(end), y(Math.round(frame.midi)))
    ctx.stroke()
  }
  ctx.strokeStyle = '#1e64be'
  ctx.lineWidth = 2.3
  ctx.lineJoin = 'round'
  ctx.beginPath()
  let last: PitchFrame | null = null
  for (const frame of visible) {
    if (
      frame.state !== 'voiced' ||
      frame.midi === null ||
      frame.midi < range.min ||
      frame.midi > range.max
    ) {
      last = null
      continue
    }
    if (!last || frame.t - last.t > 0.035) ctx.moveTo(x(frame.t), y(frame.midi))
    else ctx.lineTo(x(frame.t), y(frame.midi))
    last = frame
  }
  ctx.stroke()
  if (duration > 0) {
    ctx.strokeStyle = '#cc663d'
    ctx.lineWidth = 1.5
    ctx.beginPath()
    ctx.moveTo(x(cursor), bounds.top)
    ctx.lineTo(x(cursor), bounds.bottom)
    ctx.stroke()
  }
  ctx.restore()
}
