import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import vm from 'node:vm'

type WorkletMessage = {
  type: string
  samples?: Float32Array
  totalSamples?: number
}

type ProcessorInstance = {
  port: FakePort
  process(inputs: Float32Array[][]): boolean
}

class FakePort {
  messages: WorkletMessage[] = []
  onmessage: ((event: { data: { type: string } }) => void) | null = null

  postMessage(message: WorkletMessage): void {
    this.messages.push(message)
  }

  dispatch(type: string): void {
    this.onmessage?.({ data: { type } })
  }
}

async function loadProcessor(
  options: Record<string, number>,
): Promise<ProcessorInstance> {
  let Processor:
    | (new (options: {
        processorOptions: Record<string, number>
      }) => ProcessorInstance)
    | undefined
  class FakeAudioWorkletProcessor {
    readonly port = new FakePort()
  }
  const context = vm.createContext({
    AudioWorkletProcessor: FakeAudioWorkletProcessor,
    Float32Array,
    globalThis: undefined,
    registerProcessor: (_name: string, implementation: typeof Processor) => {
      Processor = implementation
    },
  })
  context.globalThis = context
  const source = await readFile(
    new URL('../src/audio/capture-worklet.js', import.meta.url),
    'utf8',
  )
  const workletSource = source.replace(
    /export default import\.meta\.url\s*$/,
    '',
  )
  vm.runInContext(workletSource, context, { filename: 'capture-worklet.js' })
  assert.ok(Processor)
  return new Processor({ processorOptions: options })
}

test('worklet emits mono PCM in bounded chunks and never passes the sample cap', async () => {
  const processor = await loadProcessor({ chunkSize: 4, maxSamples: 6 })

  const keepAlive = processor.process([
    [
      Float32Array.from([1, 0.5, 0, -0.5]),
      Float32Array.from([-1, 0.5, 1, -0.5]),
    ],
  ])
  const atLimit = processor.process([[Float32Array.from([0.2, 0.4, 0.6, 0.8])]])

  assert.equal(keepAlive, true)
  assert.equal(atLimit, false)
  assert.deepEqual(
    processor.port.messages.map((message) => message.type),
    ['samples', 'samples', 'limit'],
  )
  assert.deepEqual(
    Array.from(processor.port.messages[0].samples!),
    [0, 0.5, 0.5, -0.5],
  )
  assert.deepEqual(
    processor.port.messages[1].samples,
    Float32Array.from([0.2, 0.4]),
  )
  assert.equal(processor.port.messages[2].totalSamples, 6)
})

test('worklet flushes the final partial chunk before acknowledging stop', async () => {
  const processor = await loadProcessor({ chunkSize: 4, maxSamples: 20 })
  processor.process([[Float32Array.from([0.1, 0.2, 0.3])]])

  processor.port.dispatch('stop')

  assert.deepEqual(
    processor.port.messages.map((message) => message.type),
    ['samples', 'stopped'],
  )
  assert.deepEqual(
    processor.port.messages[0].samples,
    Float32Array.from([0.1, 0.2, 0.3]),
  )
  assert.equal(processor.process([[Float32Array.of(0.4)]]), false)
})

test('worklet still acknowledges session cleanup after reaching the sample cap', async () => {
  const processor = await loadProcessor({ chunkSize: 4, maxSamples: 2 })
  processor.process([[Float32Array.from([0.1, 0.2, 0.3])]])

  processor.port.dispatch('stop')

  assert.deepEqual(
    processor.port.messages.map((message) => message.type),
    ['samples', 'limit', 'stopped'],
  )
})
