import { PitchAnalyzer, ANALYSIS_SETTINGS, type AnalysisMode, type PitchFrame } from './pipeline.ts'
import { detectYin, type YinCandidate } from './detectors.ts'

type Observation = { frame: PitchFrame; candidates: YinCandidate[] }

/** Keep the live choice plus only a strongly periodic, evidenced upper-octave alternative. */
function optionsFor({ frame, candidates }: Observation, preserve: boolean): YinCandidate[] {
  if (frame.frequency === null) return []
  const primary = { frequency: frame.frequency, error: 1 - frame.periodicity }
  if (preserve) return [primary]
  return [primary, ...candidates.filter(candidate =>
    candidate.error < .1 && candidate.error < primary.error * 4 + .01 &&
    Math.abs(1200 * Math.log2(candidate.frequency / primary.frequency) - 1200) < 60)]
}

/** Backtrack waveform candidates inside one voiced island; never continue through a rest. */
function resolveIsland(observations: Observation[], frames: PitchFrame[], start: number, end: number): void {
  const hop = frames[start + 1] ? frames[start + 1].t - frames[start].t : .01
  const support = Math.max(1, Math.ceil(.02 / hop - 1e-9))
  const preserved = new Uint8Array(end - start)
  // A stable observed short note is evidence, even if removing it would make a smoother path.
  for (let i = start; i + support <= end; i++) {
    let low = Infinity, high = -Infinity
    for (let j = i; j < i + support; j++) {
      low = Math.min(low, frames[j].midi!)
      high = Math.max(high, frames[j].midi!)
    }
    if (high - low <= .5) preserved.fill(1, i - start, i - start + support)
  }
  const options = observations.slice(start, end).map((observation, i) => optionsFor(observation, preserved[i] === 1))
  const costs: number[][] = [], predecessors: number[][] = []
  for (let i = 0; i < options.length; i++) {
    const floor = Math.min(...options[i].map(candidate => candidate.error))
    const row: number[] = [], back: number[] = []
    for (const candidate of options[i]) {
      let best = i === 0 ? 0 : Infinity, from = 0
      if (i > 0) options[i - 1].forEach((previous, j) => {
        const distance = Math.min(12, Math.abs(12 * Math.log2(candidate.frequency / previous.frequency)))
        const cost = costs[i - 1][j] + .1 * distance
        if (cost < best) { best = cost; from = j }
      })
      // The floor is numerical stabilization, not a claimed probability of correctness.
      row.push(best + Math.log((candidate.error + .00001) / (floor + .00001)))
      back.push(from)
    }
    costs.push(row)
    predecessors.push(back)
  }
  const last = costs.at(-1)!
  let choice = last.indexOf(Math.min(...last))
  for (let i = options.length - 1; i >= 0; i--) {
    if (choice !== 0) {
      const candidate = options[i][choice]
      frames[start + i] = { ...frames[start + i], frequency: candidate.frequency,
        midi: 69 + 12 * Math.log2(candidate.frequency / 440), periodicity: 1 - candidate.error }
    }
    choice = predecessors[i][choice]
  }
}

/** Remeasure only short uncertain islands with a 40ms window and two nearby voiced anchors. */
function recoverUncertain(samples: Float32Array, sampleRate: number, frames: PitchFrame[]): void {
  const size = Math.round(sampleRate * .04)
  let index = 0
  while (index < frames.length) {
    if (frames[index].state !== 'uncertain') { index++; continue }
    const start = index
    while (index < frames.length && frames[index].state === 'uncertain') index++
    const before = frames[start - 1], after = frames[index]
    if (index - start > 8 || before?.midi == null || after?.midi == null ||
      Math.abs(before.midi - after.midi) > 2) continue
    const recovered: PitchFrame[] = []
    for (let i = start; i < index; i++) {
      const offset = Math.round(frames[i].t * sampleRate - size / 2)
      if (offset < 0 || offset + size > samples.length) break
      const candidate = detectYin(samples.subarray(offset, offset + size), sampleRate)
      const expected = before.midi + (after.midi - before.midi) * (i - start + 1) / (index - start + 1)
      const midi = candidate.frequency === null ? null : 69 + 12 * Math.log2(candidate.frequency / 440)
      if (midi === null || candidate.periodicity < .9 || Math.abs(midi - expected) > .75 ||
        frames[i].rms < Math.min(before.rms, after.rms) * .35) break
      recovered.push({ ...frames[i], frequency: candidate.frequency, midi,
        periodicity: candidate.periodicity, state: 'voiced' })
    }
    // Either every frame has fresh evidence or the whole uncertain interval stays blank.
    if (recovered.length === index - start)
      for (let i = 0; i < recovered.length; i++) frames[start + i] = recovered[i]
  }
}

/** Revisit recorded PCM with future evidence while preserving live analysis, clock and silence. */
export function analyzeOffline(samples: Float32Array, sampleRate: number, mode: AnalysisMode,
  onProgress?: (progress: number) => void): PitchFrame[] {
  const observations: Observation[] = []
  const settings = ANALYSIS_SETTINGS[mode]
  const total = Math.max(1, Math.floor((samples.length - Math.round(sampleRate * settings.windowMs / 1000)) /
    Math.round(sampleRate * settings.hopMs / 1000)) + 1)
  onProgress?.(0)
  const analyzer = new PitchAnalyzer(sampleRate, mode, (frame, candidates) => {
    observations.push({ frame, candidates })
    if (observations.length % 64 === 0) onProgress?.(.8 * observations.length / total)
  })
  const frames = [...analyzer.push(samples), ...analyzer.finish()]
  onProgress?.(.8)
  let start = 0
  while (start < frames.length) {
    if (frames[start].frequency === null) { start++; continue }
    let end = start + 1
    while (end < frames.length && frames[end].frequency !== null) end++
    resolveIsland(observations, frames, start, end)
    start = end
    onProgress?.(Math.min(.95, .8 + .15 * start / frames.length))
  }
  onProgress?.(.95)
  recoverUncertain(samples, sampleRate, frames)
  onProgress?.(1)
  return frames
}
