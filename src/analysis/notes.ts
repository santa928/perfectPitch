import type { AnalysisMode, PitchFrame } from './pipeline.ts'
export type PitchMode = 'continuous' | 'rounded'
export type PianoNote = {
  start: number
  end: number
  midi: number
  contour: { t: number; midi: number }[]
}

/** 無声境界の50ms以下のoctave候補だけ、隣接する80ms以上の安定音へ寄せる。 */
function correctBoundaryOctave(pitches: (number | null)[], start: number, end: number, hop: number, reverse: boolean): void {
  const index = (offset: number): number => reverse ? end - 1 - offset : start + offset
  const first = pitches[index(0)]!
  let count = 1
  while (count < end - start && Math.abs(pitches[index(count)]! - first) < .5) count++
  const support = Math.ceil(.08 / hop - 1e-9)
  if (count * hop > .05 + 1e-9 || count + support > end - start) return
  const anchor = pitches[index(count)]!
  const shift = Math.round((anchor - first) / 12) * 12
  if (shift !== -12 || Math.abs(anchor - first - shift) >= .5) return
  for (let i = count; i < count + support; i++)
    if (Math.abs(pitches[index(i)]! - anchor) >= .5) return
  // 倍音差だけ補正し、元のcents変動と発音時刻は保持する。休符や内部跳躍は対象外。
  for (let i = 0; i < count; i++) pitches[index(i)]! += shift
}

/** 孤立/境界octaveを補正し、30ms未満の孤立有声区間を除く。原解析値は変更しない。 */
function playbackPitches(frames: PitchFrame[], hop: number): (number | null)[] {
  const pitches = frames.map((frame, i) => {
    const value = frame.state === 'voiced' ? frame.midi : null
    const before = frames[i - 1],
      after = frames[i + 1]
    if (
      value !== null &&
      before?.state === 'voiced' &&
      after?.state === 'voiced' &&
      before.midi !== null &&
      after.midi !== null &&
      after.t - before.t <= 0.031 &&
      Math.abs(before.midi - after.midi) < 0.5 &&
      Math.abs(Math.abs(value - before.midi) - 12) < 0.5
    )
      return (before.midi + after.midi) / 2
    return value
  })
  let start = 0
  while (start < pitches.length) {
    if (pitches[start] === null) { start++; continue }
    let end = start + 1
    while (
      end < pitches.length && pitches[end] !== null &&
      frames[end].t - frames[end - 1].t <= hop * 1.8
    ) end++
    // 音符ごとの短さで切らない。持続声の途中にある本物の短い跳躍は保持する。
    if (frames[end - 1].t - frames[start].t + hop < 0.03 - 1e-9)
      pitches.fill(null, start, end)
    else {
      correctBoundaryOctave(pitches, start, end, hop, false)
      correctBoundaryOctave(pitches, start, end, hop, true)
    }
    start = end
  }
  return pitches
}

/** Derive note intervals without changing the recording. Null frames preserve rests; contour preserves cents. */
export function buildNotes(
  frames: PitchFrame[],
  mode: AnalysisMode,
  pitchMode: PitchMode,
  duration: number,
): PianoNote[] {
  if (!frames.length || duration <= 0) return []
  const notes: PianoNote[] = []
  const hop =
    frames.length > 1 ? Math.min(0.04, frames[1].t - frames[0].t) : 0.01
  const pitches = playbackPitches(frames, hop)
  let current: PianoNote | null = null
  let lastPitch: number | null = null
  /** Close at the frame boundary so silence never becomes a sustained piano note. */
  const close = (end: number): void => {
    if (current) {
      current.end = Math.min(duration, end)
      if (current.end > current.start) notes.push(current)
    }
    current = null
    lastPitch = null
  }
  for (let i = 0; i < frames.length; i++) {
    const raw = pitches[i]
    const boundary = Math.max(0, frames[i].t - hop / 2)
    if (raw === null) {
      close(boundary)
      continue
    }
    if (current && i > 0 && frames[i].t - frames[i - 1].t > hop * 1.8)
      close(frames[i - 1].t + hop / 2)
    const rounded: number =
      current && Math.abs(raw - current.midi) < 0.65
        ? current.midi
        : Math.round(raw)
    const pitch: number = pitchMode === 'rounded' ? rounded : raw
    const change =
      current &&
      (pitchMode === 'rounded'
        ? pitch !== current.midi
        : lastPitch !== null &&
          Math.abs(raw - lastPitch) >= (mode === 'song' ? 0.8 : 1.5))
    if (change) close(boundary)
    if (!current)
      current = { start: boundary, end: boundary, midi: pitch, contour: [] }
    current.contour.push({ t: frames[i].t, midi: pitch })
    lastPitch = raw
  }
  close(Math.min(duration, frames.at(-1)!.t + hop / 2))
  return notes
}
