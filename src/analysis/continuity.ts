import type { PitchFrame } from './pipeline.ts'

const MAX_DROP_SECONDS = .02
const MIN_DROP_SEMITONES = 10
const ANCHOR_TOLERANCE = .5
const MAX_FRAME_GAP = .015

/** 10ms解析の連続した有声フレームだけを支持区間として扱う。 */
function connected(a: PitchFrame | undefined, b: PitchFrame | undefined): boolean {
  return !!a && !!b && a.state === 'voiced' && b.state === 'voiced' &&
    a.midi !== null && b.midi !== null && b.t > a.t && b.t - a.t <= MAX_FRAME_GAP
}

/** 急落の両側に約30msの安定した声を要求し、休符や欠落を跨がない。 */
function supported(frames: readonly PitchFrame[], index: number, direction: -1 | 1): boolean {
  const anchor = frames[index]
  let previous = index
  for (let next = index + direction; next >= 0 && next < frames.length; next += direction) {
    const frame = frames[next]
    if (!connected(frames[Math.min(previous, next)], frames[Math.max(previous, next)]) ||
      Math.abs(frame.midi! - anchor.midi!) >= ANCHOR_TOLERANCE) return false
    if (Math.abs(frame.t - anchor.t) >= .02 - 1e-9) return true
    previous = next
  }
  return false
}

/**
 * 同じ安定音へ20ms以内に戻る10半音以上の急落だけを前後の音高で補間する。
 * 表示・再生・楽譜共通の派生値。原frames/PCM、休符、持続低音、滑らかな下降は変更しない。
 * 同形の本物の短い低音との完全な区別はできない。前後の根拠がない境界音は保持する。
 */
export function stabilizePitchFrames(frames: readonly PitchFrame[]): PitchFrame[] {
  const result = frames.slice()
  for (let start = 1; start < frames.length; start++) {
    const before = frames[start - 1], first = frames[start]
    if (!connected(before, first) || before.midi! - first.midi! < MIN_DROP_SEMITONES ||
      !supported(frames, start - 1, -1)) continue
    let end = start
    while (end < frames.length && connected(frames[end - 1], frames[end]) &&
      before.midi! - frames[end].midi! >= MIN_DROP_SEMITONES &&
      frames[end].t - first.t <= MAX_DROP_SECONDS + 1e-9) end++
    const after = frames[end]
    if (!connected(frames[end - 1], after) || after.t - first.t > MAX_DROP_SECONDS + 1e-9 ||
      Math.abs(after.midi! - before.midi!) >= ANCHOR_TOLERANCE || !supported(frames, end, 1)) continue
    for (let i = start; i < end; i++) {
      const frame = frames[i]
      const midi = before.midi! + (after.midi! - before.midi!) * (frame.t - before.t) / (after.t - before.t)
      result[i] = { ...frame, midi, frequency: 440 * 2 ** ((midi - 69) / 12) }
    }
    start = end
  }
  return result
}
