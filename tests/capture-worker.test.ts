import assert from 'node:assert/strict'
import test from 'node:test'
import { Worker } from 'node:worker_threads'
import { analyze, type PitchFrame } from '../src/analysis/pipeline.ts'

const sampleRate = 48000

function signal(): Float32Array {
  return Float32Array.from(
    { length: Math.round(sampleRate * 0.7) },
    (_, index) =>
      index < sampleRate * 0.32
        ? 0
        : 0.2 * Math.sin((2 * Math.PI * 220 * index) / sampleRate),
  )
}

async function analysisWorker(): Promise<Worker> {
  const moduleUrl = new URL('../src/audio/analysis-worker.ts', import.meta.url)
    .href
  const wrapper = `
    import { parentPort } from 'node:worker_threads';
    globalThis.self = globalThis;
    globalThis.postMessage = (message, transfer) => parentPort.postMessage(message, transfer);
    parentPort.on('message', data => globalThis.onmessage?.({ data }));
    await import(${JSON.stringify(moduleUrl)});
    parentPort.postMessage({ type: 'ready' });
  `
  const worker = new Worker(
    new URL(`data:text/javascript,${encodeURIComponent(wrapper)}`),
    { type: 'module' },
  )
  await nextMessage(worker, (message) => message.type === 'ready')
  return worker
}

function nextMessage(
  worker: Worker,
  accept: (message: { type: string }) => boolean,
): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const onMessage = (message: Record<string, unknown>): void => {
      if (!accept(message as { type: string })) return
      worker.off('error', onError)
      worker.off('message', onMessage)
      resolve(message)
    }
    const onError = (error: Error): void => {
      worker.off('message', onMessage)
      reject(error)
    }
    worker.on('message', onMessage)
    worker.on('error', onError)
  })
}

test('analysis worker streams sample-clock frames and performs final offline reanalysis', async () => {
  const worker = await analysisWorker()
  const samples = signal()
  try {
    worker.postMessage({ type: 'init', sampleRate, mode: 'song' })
    const liveMessage = nextMessage(
      worker,
      (message) => message.type === 'frames',
    )
    const liveCopy = samples.slice()
    worker.postMessage({ type: 'chunk', samples: liveCopy }, [liveCopy.buffer])
    const liveFrames = (await liveMessage).frames as PitchFrame[]

    const doneMessage = nextMessage(
      worker,
      (message) => message.type === 'done',
    )
    const offlineCopy = samples.slice()
    worker.postMessage(
      { type: 'reanalyze', samples: offlineCopy, sampleRate, mode: 'song' },
      [offlineCopy.buffer],
    )
    const offlineFrames = (await doneMessage).frames as PitchFrame[]

    assert.ok(liveFrames.some((frame) => frame.state === 'voiced'))
    assert.deepEqual(offlineFrames, analyze(samples, sampleRate, 'song'))
  } finally {
    await worker.terminate()
  }
})
