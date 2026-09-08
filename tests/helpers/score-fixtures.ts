import type { PianoNote } from '../../src/analysis/notes.ts'

export const scoreCases = [
  { id: 'cdc', label: 'C-D-C：中央のDは100ms', duration: 1, pitches: [60, 62, 60],
    notes: [[0, .2, 60], [.2, .3, 62], [.3, 1, 60]] },
  { id: 'reattack', label: '同音3発音：中央は20ms', duration: 1, pitches: [60, 60, 60],
    notes: [[0, .46, 60], [.46, .48, 60], [.48, 1, 60]] },
  { id: 'long', label: '小節をまたぐ5秒のC：1打鍵', duration: 5, pitches: [60], notes: [[0, 5, 60]] },
]

/** 決定的な原音秒の音符を作り、検出器を介さないScoreの回帰に使用する。 */
export function performanceNotes(rows: number[][]): PianoNote[] {
  return rows.map(([start, end, midi]) => ({ start, end, midi, contour: [] }))
}

/** 既知の合成音符を16bit mono WAVへ変換する。個人音声を使わない。 */
export function syntheticWav(notes: readonly PianoNote[], duration: number, rate = 48000): Buffer {
  const data = new Float32Array(Math.round(duration * rate))
  for (const note of notes) for (let i = Math.round(note.start * rate); i < Math.min(data.length, Math.round(note.end * rate)); i++) {
    const time = i / rate - note.start
    const envelope = Math.min(1, time / .003, (note.end - i / rate) / .003)
    data[i] += .25 * envelope * Math.sin(2 * Math.PI * 440 * 2 ** ((note.midi - 69) / 12) * time)
  }
  return pcmWav(data, rate)
}

/** レンダリング済みPCMも同じWAVコンテナへ保存する。音声の生成経路は呼出し側で明示する。 */
export function pcmWav(samples: ArrayLike<number>, rate: number): Buffer {
  const wav = Buffer.alloc(44 + samples.length * 2)
  wav.write('RIFF'); wav.writeUInt32LE(wav.length - 8, 4); wav.write('WAVEfmt ', 8)
  wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22)
  wav.writeUInt32LE(rate, 24); wav.writeUInt32LE(rate * 2, 28)
  wav.writeUInt16LE(2, 32); wav.writeUInt16LE(16, 34); wav.write('data', 36)
  wav.writeUInt32LE(samples.length * 2, 40)
  for (let i = 0; i < samples.length; i++) wav.writeInt16LE(Math.round(Math.max(-1, Math.min(1, samples[i])) * 32767), 44 + i * 2)
  return wav
}
