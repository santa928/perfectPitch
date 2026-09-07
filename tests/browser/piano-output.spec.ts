import { test, expect } from '@playwright/test'

test('明示した連続音高モードは短い音源を持続させ、centsと遅いしゃくりを保持する', async ({
  page,
}) => {
  await page.goto('./')
  const output = await page.evaluate(async () => {
    const { schedulePianoVoice } = await import(
      '/perfectPitch/src/audio/piano-voice.ts'
    )
    const sr = 48000
    /** Measure actual rendered PCM by rising crossings, excluding attack and loop boundaries. */
    function measuredFrequency(
      data: Float32Array,
      start: number,
      end: number,
    ): number {
      const crossings: number[] = []
      for (let i = Math.floor(start * sr) + 1; i < end * sr; i++)
        if (data[i - 1] <= 0 && data[i] > 0)
          crossings.push(i - 1 - data[i - 1] / (data[i] - data[i - 1]))
      return ((crossings.length - 1) * sr) / (crossings.at(-1)! - crossings[0])
    }
    /** Render with a deliberately 200ms source, far shorter than the scheduled 4s note. */
    async function render(midi: number, glide = false) {
      const context = new OfflineAudioContext(1, sr * 5, sr)
      const sample = context.createBuffer(1, sr * 0.2, sr)
      const pcm = sample.getChannelData(0)
      for (let i = 0; i < pcm.length; i++)
        pcm[i] = 0.3 * Math.sin((2 * Math.PI * 440 * i) / sr)
      schedulePianoVoice(context, {
        sample,
        sampleMidi: 69,
        note: {
          start: 0.1,
          end: 4.2,
          midi,
          contour: [
            { t: 0.1, midi },
            { t: 3.2, midi },
            { t: 3.6, midi: glide ? midi + 12 : midi },
            { t: 4.1, midi: glide ? midi + 12 : midi },
          ],
        },
        startedAt: 0,
        offset: 0,
        sound: 'continuous',
      })
      const rendered = (await context.startRendering()).getChannelData(0)
      const late = rendered.subarray(sr * 3.8, sr * 4)
      return {
        rms: Math.sqrt(late.reduce((sum, x) => sum + x * x, 0) / late.length),
        hz: measuredFrequency(rendered, 3.8, 4),
        afterEnd: Math.max(
          ...rendered.subarray(sr * 4.3, sr * 4.4).map(Math.abs),
        ),
      }
    }
    return {
      positive: await render(69.3),
      negative: await render(68.7),
      rounded: await render(69),
      glide: await render(69, true),
    }
  })
  console.log('PIANO_RENDERED_OUTPUT', JSON.stringify(output))
  await test
    .info()
    .attach('rendered-piano-metrics', {
      body: JSON.stringify(output, null, 2),
      contentType: 'application/json',
    })
  for (const rendered of Object.values(output)) {
    expect(rendered.rms).toBeGreaterThan(0.1)
    expect(rendered.afterEnd).toBe(0)
  }
  expect(
    Math.abs(1200 * Math.log2(output.positive.hz / 440) - 30),
  ).toBeLessThan(2)
  expect(
    Math.abs(1200 * Math.log2(output.negative.hz / 440) + 30),
  ).toBeLessThan(2)
  expect(Math.abs(1200 * Math.log2(output.rounded.hz / 440))).toBeLessThan(2)
  expect(Math.abs(1200 * Math.log2(output.glide.hz / 880))).toBeLessThan(2)
})

test('通常のピアノは鍵盤の音程と元サンプルの減衰を保ち、声のcontourで滑らない', async ({ page }) => {
  await page.goto('./')
  const result = await page.evaluate(async () => {
    const { schedulePianoVoice } = await import('/perfectPitch/src/audio/piano-voice.ts')
    const sr = 48000, context = new OfflineAudioContext(1, sr * 4, sr)
    const sample = context.createBuffer(1, sr * 2.5, sr)
    for (let i = 0; i < sample.length; i++)
      sample.getChannelData(0)[i] = .4 * Math.exp(-2 * i / sr) * Math.sin(2 * Math.PI * 440 * i / sr)
    schedulePianoVoice(context, {
      sample, sampleMidi: 69, startedAt: 0, offset: 0,
      note: { start: .1, end: 3.5, midi: 69.3, contour: [{ t: .1, midi: 69.3 }, { t: 1, midi: 81 }] },
    })
    const data = (await context.startRendering()).getChannelData(0)
    const rms = (start: number, end: number) => {
      const part = data.subarray(start * sr, end * sr)
      return Math.sqrt(part.reduce((sum, value) => sum + value * value, 0) / part.length)
    }
    const crossings: number[] = []
    for (let i = 1.2 * sr; i < 1.4 * sr; i++)
      if (data[i - 1] <= 0 && data[i] > 0) crossings.push(i - 1 - data[i - 1] / (data[i] - data[i - 1]))
    return { hz: (crossings.length - 1) * sr / (crossings.at(-1)! - crossings[0]),
      attack: rms(.12, .22), late: rms(1.2, 1.3), afterSample: rms(3, 3.2) }
  })
  expect(Math.abs(1200 * Math.log2(result.hz / 440))).toBeLessThan(2)
  expect(result.attack).toBeGreaterThan(.1)
  expect(result.late / result.attack).toBeLessThan(.2)
  expect(result.afterSample).toBe(0)
})

test('ピアノは離鍵後に短く減衰し、再開時は元の減衰位置から再生する', async ({ page }) => {
  await page.goto('./')
  const result = await page.evaluate(async () => {
    const { schedulePianoVoice } = await import('/perfectPitch/src/audio/piano-voice.ts')
    const sr = 48000
    /** 同じ打鍵を全体と途中再開でレンダーし、打鍵のやり直しを検出する。 */
    async function render(offset: number, end: number) {
      const context = new OfflineAudioContext(1, sr * 3, sr)
      const sample = context.createBuffer(1, sr * 3, sr)
      for (let i = 0; i < sample.length; i++)
        sample.getChannelData(0)[i] = .4 * Math.exp(-i / sr) * Math.sin(2 * Math.PI * 440 * i / sr)
      schedulePianoVoice(context, { sample, sampleMidi: 69, startedAt: 0, offset,
        note: { start: .1, end, midi: 69, contour: [] } })
      return (await context.startRendering()).getChannelData(0)
    }
    const full = await render(0, 2.2), resumed = await render(1, 2.2), short = await render(0, .4)
    const rms = (data: Float32Array, start: number, end: number) => {
      const part = data.subarray(start * sr, end * sr)
      return Math.sqrt(part.reduce((sum, value) => sum + value * value, 0) / part.length)
    }
    return { resumeRatio: rms(resumed, .1, .3) / rms(full, 1.1, 1.3),
      release: rms(short, .41, .45), afterRelease: rms(short, .55, .6) }
  })
  expect(result.resumeRatio).toBeGreaterThan(.98)
  expect(result.resumeRatio).toBeLessThan(1.02)
  expect(result.release).toBeGreaterThan(.01)
  expect(result.afterRelease).toBe(0)
})

test('stopping a scheduled voice releases both source and gain and emits no PCM', async ({
  page,
}) => {
  await page.goto('./')
  const result = await page.evaluate(async () => {
    const { schedulePianoVoice } = await import(
      '/perfectPitch/src/audio/piano-voice.ts'
    )
    const context = new OfflineAudioContext(1, 48000, 48000)
    const sample = context.createBuffer(1, 9600, 48000)
    sample.getChannelData(0).forEach((_, i, pcm) => {
      pcm[i] = Math.sin((2 * Math.PI * 440 * i) / 48000)
    })
    let ended = 0,
      sourceDisconnected = 0,
      gainDisconnected = 0
    const voice = schedulePianoVoice(context, {
      sample,
      sampleMidi: 69,
      note: { start: 0.1, end: 0.9, midi: 69, contour: [] },
      startedAt: 0,
      offset: 0,
      onEnded: () => ended++,
    })
    const sourceDisconnect = voice.source.disconnect.bind(voice.source),
      gainDisconnect = voice.gain.disconnect.bind(voice.gain)
    voice.source.disconnect = () => {
      sourceDisconnected++
      sourceDisconnect()
    }
    voice.gain.disconnect = () => {
      gainDisconnected++
      gainDisconnect()
    }
    voice.stop()
    voice.stop()
    const data = (await context.startRendering()).getChannelData(0)
    return {
      ended,
      sourceDisconnected,
      gainDisconnected,
      energy: data.reduce((sum, x) => sum + x * x, 0),
    }
  })
  expect(result).toEqual({
    ended: 1,
    sourceDisconnected: 1,
    gainDisconnected: 1,
    energy: 0,
  })
})
