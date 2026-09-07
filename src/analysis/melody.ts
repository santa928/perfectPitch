import type { PitchFrame } from './pipeline.ts'
import type { PianoNote } from './notes.ts'
import { stabilizePitchFrames } from './continuity.ts'

/** A tempo is a grid proposal, not a claim about the singer's intended beat or meter. */
export type TempoSuggestion = { bpm: number; alternatives: number[]; reliable: boolean }

/** Find a strong renewed attack inside a steady pitch; mild amplitude vibrato does not split it. */
function reattacks(frames: readonly PitchFrame[], start: number, end: number, hop: number): number[] {
  const attacks: number[] = []
  const support = Math.ceil(.08 / hop - 1e-9)
  let last = start
  for (let i = start + support; i < end - support; i++) {
    if (i - last < support) continue
    // RMS already spans the analysis window; use the earlier shoulder, not its falling edge.
    const before = frames.slice(Math.max(start, i - Math.round(.1 / hop)), i).map(f => f.rms)
    const level = Math.max(...before)
    if (!(level > .0001) || frames[i].rms > level * .3) continue
    let j = i + 1
    while (j < end && frames[j].rms <= level * .35) j++
    const length = (j - i) * hop
    if (length < .02 - 1e-9 || length > .08 + 1e-9 || j + support > end) continue
    const rebound = j + Math.max(1, Math.round(.04 / hop))
    if (rebound >= end || frames[rebound].rms < level * .7) continue
    const after = frames.slice(rebound, Math.min(end, rebound + Math.max(2, Math.round(.03 / hop))))
    if (!after.every(f => f.rms >= level * .7)) continue
    attacks.push(j)
    last = j
    i = j
  }
  return attacks
}

/** Select integer note centers inside one voiced island, keeping source pitch evidence untouched. */
function islandNotes(frames: readonly PitchFrame[], start: number, end: number, hop: number, duration: number): PianoNote[] {
  if (frames[end - 1].t - frames[start].t + hop < .03 - 1e-9) return []
  let low = 108, high = 21
  for (let i = start; i < end; i++) {
    low = Math.min(low, Math.floor(frames[i].midi!) - 1)
    high = Math.max(high, Math.ceil(frames[i].midi!) + 1)
  }
  low = Math.max(21, low); high = Math.min(108, high)
  const count = high - low + 1
  let costs = new Float64Array(count)
  const predecessors: Uint8Array[] = []
  for (let i = start; i < end; i++) {
    const next = new Float64Array(count), back = new Uint8Array(count)
    for (let key = 0; key < count; key++) {
      let best = i === start ? 0 : Infinity, from = 0
      if (i > start) for (let previous = 0; previous < count; previous++) {
        const transition = previous === key ? 0 : 2 + .3 * Math.min(12, Math.abs(previous - key))
        const cost = costs[previous] + transition
        if (cost < best) { best = cost; from = previous }
      }
      // This note-level objective is not a new F0 measurement or calibrated confidence.
      next[key] = best + Math.min(4, (frames[i].midi! - low - key) ** 2) * hop / .01
      back[key] = from
    }
    costs = next
    predecessors.push(back)
  }
  let choice = costs.indexOf(Math.min(...costs))
  const path = new Uint8Array(end - start)
  for (let i = path.length - 1; i >= 0; i--) {
    path[i] = low + choice
    choice = predecessors[i][choice]
  }
  const notes: PianoNote[] = []
  for (let i = 0; i < path.length;) {
    let j = i + 1
    while (j < path.length && path[j] === path[i]) j++
    const boundaries = [start + i, ...reattacks(frames, start + i, start + j, hop), start + j]
    for (let k = 0; k < boundaries.length - 1; k++) {
      const onset = Math.max(0, frames[boundaries[k]].t - hop / 2)
      const offset = Math.min(duration, frames[boundaries[k + 1] - 1].t + hop / 2)
      if (offset > onset) notes.push({ start: onset, end: offset, midi: path[i], contour: [{ t: onset, midi: path[i] }] })
    }
    i = j
  }
  return notes
}

/** Derive a humming melody without filling unvoiced/uncertain gaps or modifying raw cents and PCM. */
export function extractMelody(frames: readonly PitchFrame[], duration: number): PianoNote[] {
  if (!Number.isFinite(duration) || duration <= 0 || !frames.length) return []
  frames = stabilizePitchFrames(frames)
  const differences = frames.slice(1).map((f, i) => f.t - frames[i].t).filter(t => t > 0 && t <= .04).sort((a,b) => a-b)
  const hop = differences.length ? differences[Math.floor(differences.length / 2)] : .01
  const valid = (frame: PitchFrame): boolean => frame.state === 'voiced' && frame.midi !== null &&
    Number.isFinite(frame.midi) && frame.midi >= 21 && frame.midi <= 108 && Number.isFinite(frame.t) && frame.t >= 0 && frame.t <= duration
  const notes: PianoNote[] = []
  let start = 0
  while (start < frames.length) {
    if (!valid(frames[start])) { start++; continue }
    let end = start + 1
    while (end < frames.length && valid(frames[end]) && frames[end].t > frames[end-1].t && frames[end].t - frames[end-1].t <= hop * 1.8) end++
    notes.push(...islandNotes(frames, start, end, hop, duration))
    start = end
  }
  return notes
}

/** Rank sixteenth-note grids by onset/end fit; retain tempo ambiguity and allow manual correction. */
export function suggestTempo(notes: readonly PianoNote[]): TempoSuggestion {
  const valid = notes.filter(n => Number.isFinite(n.start) && Number.isFinite(n.end) && n.end > n.start)
  if (valid.length < 4) return { bpm: 120, alternatives: [], reliable: false }
  const origin = valid[0].start
  const points = valid.flatMap(n => [n.start - origin, n.end - origin])
  const candidates = Array.from({length:201}, (_, i) => {
    const bpm = 40 + i, tick = 15 / bpm
    const error = points.reduce((sum, t) => sum + (t / tick - Math.round(t / tick)) ** 2, 0) / points.length
    // Near-equal grid fits prefer a readable middle tempo; alternatives remain explicit.
    return { bpm, error, cost: error + .002 * Math.abs(Math.log2(bpm / 120)) }
  }).sort((a,b) => a.cost - b.cost)
  const selected = candidates[0]
  const alternatives: number[] = []
  for (const candidate of candidates) {
    if (Math.abs(candidate.bpm - selected.bpm) < 8 || alternatives.some(bpm => Math.abs(candidate.bpm - bpm) < 8)) continue
    if (candidate.error <= selected.error + .012) alternatives.push(candidate.bpm)
    if (alternatives.length === 2) break
  }
  const tick = 15 / selected.bpm
  const intervals = valid.slice(1).map((n,i) => (n.start - valid[i].start) / tick)
  const aligned = intervals.filter(t => t > 0 && Math.abs(t - Math.round(t)) <= .16).length / intervals.length
  return { bpm: selected.bpm, alternatives, reliable: Math.sqrt(selected.error) < .14 && aligned >= .8 }
}
