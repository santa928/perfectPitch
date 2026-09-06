import {
  analyze,
  PitchAnalyzer,
  type AnalysisMode,
  type PitchFrame,
} from '../analysis/pipeline.ts'

type AnalysisWorkerInput =
  | { type: 'init'; sampleRate: number; mode: AnalysisMode }
  | { type: 'chunk'; samples: Float32Array }
  | { type: 'finish' }
  | {
      type: 'reanalyze'
      samples: Float32Array
      sampleRate: number
      mode: AnalysisMode
    }

type AnalysisWorkerOutput =
  | { type: 'frames'; frames: PitchFrame[] }
  | { type: 'done'; frames: PitchFrame[] }
  | { type: 'error'; message: string }

type WorkerScope = {
  onmessage: ((event: MessageEvent<AnalysisWorkerInput>) => void) | null
  postMessage(message: AnalysisWorkerOutput): void
}

const workerScope = globalThis as unknown as WorkerScope
let analyzer: PitchAnalyzer | null = null

/** PCM stream と offline 再解析要求を同じ解析 pipeline へ接続する。 */
workerScope.onmessage = (event: MessageEvent<AnalysisWorkerInput>): void => {
  try {
    const message = event.data
    if (message.type === 'init') {
      analyzer = new PitchAnalyzer(message.sampleRate, message.mode)
      return
    }
    if (message.type === 'chunk') {
      if (!analyzer) throw new Error('Analysis worker is not initialized')
      workerScope.postMessage({
        type: 'frames',
        frames: analyzer.push(message.samples),
      })
      return
    }
    if (message.type === 'finish') {
      if (!analyzer) throw new Error('Analysis worker is not initialized')
      workerScope.postMessage({ type: 'frames', frames: analyzer.finish() })
      analyzer = null
      return
    }
    workerScope.postMessage({
      type: 'done',
      frames: analyze(message.samples, message.sampleRate, message.mode),
    })
  } catch (error) {
    workerScope.postMessage({
      type: 'error',
      message:
        error instanceof Error
          ? error.message
          : 'Unknown analysis worker error',
    })
  }
}
