import type { AnalysisMode, PitchFrame } from './pipeline.ts'
export type PitchMode = 'continuous' | 'rounded'
export type PianoNote = {
  start: number
  end: number
  midi: number
  contour: { t: number; midi: number }[]
}

/** Correct an isolated octave excursion only when both immediate neighbors agree; raw frames are untouched. */
function playbackPitches(frames: PitchFrame[]): (number | null)[] {
  return frames.map((frame, i) => {
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
}

/** Derive note intervals without changing the recording. Null frames preserve rests; contour preserves cents. */
export function buildNotes(
  frames: PitchFrame[],
  mode: AnalysisMode,
  pitchMode: PitchMode,
  duration: number,
): PianoNote[] {
  if (!frames.length || duration <= 0) return []
  const pitches = playbackPitches(frames)
  const notes: PianoNote[] = []
  const hop =
    frames.length > 1 ? Math.min(0.04, frames[1].t - frames[0].t) : 0.01
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
