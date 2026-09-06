import { mkdirSync, writeFileSync } from 'node:fs'
const rate = 48000,
  seconds = 4
const buffer = Buffer.alloc(44 + rate * seconds * 2)
buffer.write('RIFF')
buffer.writeUInt32LE(buffer.length - 8, 4)
buffer.write('WAVEfmt ', 8)
buffer.writeUInt32LE(16, 16)
buffer.writeUInt16LE(1, 20)
buffer.writeUInt16LE(1, 22)
buffer.writeUInt32LE(rate, 24)
buffer.writeUInt32LE(rate * 2, 28)
buffer.writeUInt16LE(2, 32)
buffer.writeUInt16LE(16, 34)
buffer.write('data', 36)
buffer.writeUInt32LE(buffer.length - 44, 40)
for (let i = 0; i < rate * seconds; i++) {
  const t = i / rate
  const frequency = t < 2 ? 440 * 2 ** (30 / 1200) : 220
  const value =
    t < 0.5 || (t > 1.5 && t < 1.8) || t > 3.5
      ? 0
      : Math.sin(2 * Math.PI * frequency * t) * 0.3
  buffer.writeInt16LE(Math.round(value * 32767), 44 + i * 2)
}
mkdirSync('output', { recursive: true })
writeFileSync('output/test-voice.wav', buffer)
/** 弱い基音の母音風信号と本物のオクターブ跳躍を、ブラウザの合成マイクへ与える。 */
for (let i = 0; i < rate * seconds; i++) {
  const t = i / rate
  const frequency = t < 2 ? 130 : 260
  const angle = 2 * Math.PI * frequency * t
  const value = t < .5 || (t > 1.5 && t < 1.8) || t > 3.5
    ? 0 : .025 * Math.sin(angle) + .25 * Math.sin(2 * angle)
  buffer.writeInt16LE(Math.round(value * 32767), 44 + i * 2)
}
writeFileSync('output/test-dominant-second.wav', buffer)
