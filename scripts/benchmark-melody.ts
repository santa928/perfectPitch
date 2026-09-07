import { writeFileSync } from 'node:fs'
import { buildNotes, type PianoNote } from '../src/analysis/notes.ts'
import { extractMelody } from '../src/analysis/melody.ts'
import { analyzeOffline } from '../src/analysis/offline.ts'
import type { PitchFrame } from '../src/analysis/pipeline.ts'

/** Measure note centers separately from boundary error; exact sequence is a stricter musical check. */
function measure(notes: PianoNote[], center: number, step: number, start: number, end: number) {
  const at = (t: number): number | null => notes.find(n => n.start <= t && n.end > t)?.midi ?? null
  const short = notes.filter(n => n.midi === center + step && n.start < end && n.end > start)
  return {
    notes: notes.length,
    exactSequence: notes.map(n => n.midi).join() === [center,center+step,center].join(),
    wrongCenters: [start-.15,(start+end)/2,end+.15].filter((t,i) => at(t) !== (i===1?center+step:center)).length,
    shortRetained: short.some(n => Math.min(n.end,end)-Math.max(n.start,start) >= .05-1e-9),
    onsetErrorMs: short.length ? Math.min(...short.map(n=>Math.abs(n.start-start)*1000)) : null,
    endErrorMs: short.length ? Math.min(...short.map(n=>Math.abs(n.end-end)*1000)) : null,
  }
}

type Measurement = ReturnType<typeof measure> & { ms: number }
type Comparison = { kind: string; legacy: Measurement; melody: Measurement; [key: string]: unknown }
const rows: Comparison[] = []
/** The supplied melody is known; no recording or original song is used as a decoder input. */
function compare(frames: PitchFrame[], duration: number, center: number, step: number, start: number, end: number, description: {kind:string;[key:string]:unknown}) {
  const before = performance.now()
  const legacy = buildNotes(frames, 'song', 'rounded', duration)
  const middle = performance.now()
  const melody = extractMelody(frames, duration)
  rows.push({...description, center, step, legacy:{...measure(legacy,center,step,start,end),ms:middle-before},
    melody:{...measure(melody,center,step,start,end),ms:performance.now()-middle}})
}

for (const center of [46,60]) for (const depth of [0,.3,.7]) for (const speed of [4,6])
  for (const step of [-12,-2,-1,1,2,12]) for (const phase of [0,Math.PI/2,Math.PI]) {
    const frames: PitchFrame[] = Array.from({length:200}, (_,i) => {
      const t=.005+i/100, midi=center+(t>=.8&&t<.9?step:0)+depth*Math.sin(2*Math.PI*speed*t+phase)
      return {t,midi,frequency:440*2**((midi-69)/12),rms:.1,periodicity:1,state:'voiced'}
    })
    compare(frames,2,center,step,.8,.9,{kind:'known-frames',depth,speed,phase})
  }

// PCM path is separate: here the real detector can miss or misestimate before note inference.
for (const sr of [44100,48000]) for (const center of [46,60]) for (const step of [1,12]) for (const depth of [0,.3,.7]) {
  let phase=0
  const pcm=Float32Array.from({length:Math.round(sr*1.8)},(_,i)=>{
    const t=i/sr
    if(t<.4||t>=1.6)return 0
    const midi=center+(t>=.8&&t<.9?step:0)+depth*Math.sin(2*Math.PI*6*t)
    phase+=2*Math.PI*440*2**((midi-69)/12)/sr
    return .15*Math.sin(phase)+.07*Math.sin(2*phase)+.04*Math.sin(3*phase)
  })
  compare(analyzeOffline(pcm,sr,'song'),1.8,center,step,.8,.9,{kind:'synthetic-pcm',sr,depth})
}

writeFileSync(process.argv[2]??'docs/evaluation/melody-results.json',JSON.stringify({
  environment:{node:process.version,arch:process.arch,platform:process.platform},
  method:'Legacy=existing rounded notes. Melody=integer-note candidate sequence. Known frames isolate note inference; synthetic PCM includes the production offline detector. These are tuning/regression fixtures, not held-out real voice accuracy. Runtime covers note inference only.',rows,
},null,2)+'\n')
for(const kind of ['known-frames','synthetic-pcm']) {
  const selected=rows.filter(r=>r.kind===kind)
  console.log(JSON.stringify({kind,conditions:selected.length,...Object.fromEntries((['legacy','melody'] as const).map(method=>[method,{
    exactSequences:selected.filter(r=>r[method].exactSequence).length,
    wrongCenters:selected.reduce((sum,r)=>sum+r[method].wrongCenters,0),
    shortRetained:selected.filter(r=>r[method].shortRetained).length,
  }]))}))
}
