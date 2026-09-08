/** 同じ10/30/60秒PCMで本番Worker経路を測る。Docker値を実モバイルとは呼ばない。 */
import { readFileSync, writeFileSync, readdirSync, existsSync, statSync } from 'node:fs'
import { chromium } from '@playwright/test'
import { createPerformanceServer } from './performance-server.ts'
import { distribution } from './metrics.ts'
import { sourceFingerprint } from './contract.ts'

const destination = process.argv[2]
if (!destination?.startsWith('output/issue21/')) throw new Error('Expected output/issue21 destination')
if (existsSync(destination)) throw new Error('Use a new performance artifact; preserve previous measurements')
const { server, requests, origin, base } = await createPerformanceServer()
const measuredAt = new Date().toISOString(), sourceHashes = sourceFingerprint()
const browser = await chromium.launch()
const rows: unknown[] = []
/** Linux /procのChromium全プロセスRSS合計。共有ページを重複計上する上界で、JS heapとは別。 */
function browserRssKiB(): number {
  let sum = 0
  for (const id of readdirSync('/proc').filter(n => /^\d+$/.test(n))) {
    try {
      const command = readFileSync(`/proc/${id}/cmdline`, 'utf8')
      if (!command.includes('chrome') || command.includes('crashpad')) continue
      sum += Number(readFileSync(`/proc/${id}/status`, 'utf8').match(/^VmRSS:\s+(\d+)/m)?.[1] ?? 0)
    } catch { /* 監視中に終了した子プロセスは次回サンプルへ進む。 */ }
  }
  return sum
}
try {
  for (const seconds of [10, 30, 60]) {
    const context = await browser.newContext({ serviceWorkers: 'block' })
    for (const cache of ['cold-context', 'warm-http-cache']) {
    // ページ・Worker/sessionは各回作り直し、同一contextのHTTP cacheだけを維持する。
    const page = await context.newPage()
    const cdp = await context.newCDPSession(page)
    await cdp.send('Performance.enable')
    const errors: string[] = []
    page.on('pageerror', error => errors.push(error.message))
    const assets: { path: string; browserStatus: number; resourceBytes: number; responseContentLength: number | null; fromServiceWorker: boolean }[] = []
    const onResponse = (response: import('@playwright/test').Response): void => {
      const path = new URL(response.url()).pathname
      if (/\/(models|runtime)\//.test(path)) assets.push({ path, browserStatus: response.status(),
        resourceBytes: statSync(`public/${path.slice(base.length)}`).size,
        responseContentLength: response.headers()['content-length'] === undefined ? null : Number(response.headers()['content-length']),
        fromServiceWorker: response.fromServiceWorker() })
    }
    context.on('response', onResponse)
    const requestStart = requests.length
    await page.goto(`${origin}${base}`)
      let peakRssKiB = browserRssKiB()
      const monitor = setInterval(() => { peakRssKiB = Math.max(peakRssKiB, browserRssKiB()) }, 50)
      try {
        const row = await page.evaluate(async ({ seconds, base }) => {
          const rate = 48000, samples = Float32Array.from({ length: seconds * rate }, (_, i) => {
            const t = i / rate
            return t < .8 || t > seconds - .3 ? 0 : .08 * Math.sin(2 * Math.PI * 220 * t) + .02 * Math.sin(2 * Math.PI * 440 * t)
          })
          const worker = new Worker(`${base}src/audio/analysis-worker.ts`, { type: 'module' })
          const send = (message: object, expected: string, transfer: Transferable[] = []): Promise<unknown> => new Promise((resolve, reject) => {
            const timer = setTimeout(() => reject(new Error('Analysis worker timeout')), 120000)
            worker.onmessage = event => {
              if (event.data.type === 'error') { clearTimeout(timer); reject(new Error(event.data.message)) }
              if (event.data.type === expected) { clearTimeout(timer); resolve(event.data) }
            }
            worker.onerror = error => { clearTimeout(timer); reject(new Error(error.message)) }
            worker.postMessage(message, transfer)
          })
          worker.postMessage({ type: 'init', sampleRate: rate, mode: 'song' })
          const latencies: number[] = [], liveStart = performance.now()
          for (let i = 0; i < samples.length; i += 1024) {
            const chunk = samples.slice(i, i + 1024), start = performance.now()
            await send({ type: 'chunk', samples: chunk }, 'frames', [chunk.buffer])
            latencies.push(performance.now() - start)
          }
          await send({ type: 'finish' }, 'frames')
          const liveMs = performance.now() - liveStart
          const offlineStart = performance.now(), copy = samples.slice()
          await send({ type: 'reanalyze', samples: copy, sampleRate: rate, mode: 'song', calibrate: true }, 'done', [copy.buffer])
          const offlineMs = performance.now() - offlineStart
          worker.terminate()
          const { transcribeMelody } = await import(`${base}src/audio/transcription.ts`) as { transcribeMelody(s: Float32Array, r: number): Promise<unknown[]> }
          const modelStart = performance.now(), notes = await transcribeMelody(samples, rate)
          return { seconds, liveMs, offlineMs, modelMs: performance.now() - modelStart, modelNotes: notes.length, latencies }
        }, { seconds, base })
        const metrics = await cdp.send('Performance.getMetrics')
        const serverRequests = requests.slice(requestStart), remaining = [...serverRequests]
        const observedAssets = assets.map(asset => {
          const index = remaining.findIndex(request => request.path === asset.path)
          const request = index < 0 ? null : remaining.splice(index, 1)[0]
          return { ...asset, acquisition: request ? (request.status === 304 ? 'revalidated' : 'network') : 'http-cache',
            serverRequest: request, serverBodyBytesWritten: request?.bodyBytesWritten ?? 0 }
        })
        if (remaining.length || !assets.some(a => a.path.endsWith('basic-pitch.onnx')) || !assets.some(a => a.path.endsWith('.wasm')))
          throw new Error('Incomplete asset observation')
        rows.push({ ...row, latencies: distribution(row.latencies), cache, newPage: true, newWorkersAndModelSession: true,
          peakChromiumRssSumKiB: peakRssKiB,
          mainPageJsHeapUsedBytes: metrics.metrics.find(m => m.name === 'JSHeapUsedSize')?.value ?? null,
          assets: observedAssets, serverRequests, errors: [...errors] })
        if (errors.length) throw new Error('Performance page errors')
        console.log(JSON.stringify({ seconds, cache, liveMs: row.liveMs, offlineMs: row.offlineMs, modelMs: row.modelMs, peakRssKiB }))
      } finally { clearInterval(monitor); context.off('response', onResponse); await page.close() }
    }
    await context.close()
  }
  if (JSON.stringify(sourceHashes) !== JSON.stringify(sourceFingerprint())) throw new Error('Source changed during measurement')
  writeFileSync(destination, JSON.stringify({ measuredAt, sourceHashes, environment: { node: process.version, browser: browser.version(), arch: process.arch },
    cacheProtocol: 'No Playwright routing; service workers blocked; new context per duration; two fresh pages and fresh workers/sessions in the same context. Vite asset cache policy unchanged. Browser responses matched against per-run server requests; absent server request means HTTP cache; 304 means revalidation. Body bytes count server write/end, excluding response headers/TLS.',
    limitations: 'Unpaced sequential 1024-sample messages; round-trip service cost, not microphone latency. Includes first module load. RSS sum duplicates shared pages; heap excludes model worker. Cold browser context, warm OS/Vite cache. No real mobile or CPU throttle. Cache protocol corrected after original holdout; no accuracy inference rerun.', rows }, null, 2))
} finally { await browser.close(); await server.close() }
