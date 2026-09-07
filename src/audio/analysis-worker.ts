import {
  PitchAnalyzer,
  type AnalysisMode,
  type PitchFrame,
} from '../analysis/pipeline.ts'
import { analyzeOffline } from '../analysis/offline.ts'

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
  | { type: 'progress'; progress: number }
  | { type: 'error'; message: string }

type WorkerScope = {
  onmessage: ((event: MessageEvent<AnalysisWorkerInput>) => void) | null
  postMessage(message: AnalysisWorkerOutput): void
}

const workerScope = globalThis as unknown as WorkerScope
let analyzer: PitchAnalyzer | null = null

/** Live estimates stay causal; recorded PCM receives future-evidence review with real progress. */
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
      frames: analyzeOffline(message.samples, message.sampleRate, message.mode,
        progress => workerScope.postMessage({ type: 'progress', progress })),
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
