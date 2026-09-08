/** 同じ10/30/60秒PCMで本番Worker経路を測る。Docker値を実モバイルとは呼ばない。 */
import { readFileSync, writeFileSync, readdirSync } from 'node:fs'
import { chromium } from '@playwright/test'
import { createServer } from 'vite'
import { distribution } from './metrics.ts'
import { sourceFingerprint } from './contract.ts'

const destination = process.argv[2]
if (!destination?.startsWith('output/issue21/')) throw new Error('Expected output/issue21 destination')
const server = await createServer({ server: { host: '127.0.0.1', port: 0 } })
await server.listen()
const address = server.httpServer!.address()
if (!address || typeof address === 'string') throw new Error('No server address')
const origin = `http://127.0.0.1:${address.port}`, base = server.config.base
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
    const context = await browser.newContext(), page = await context.newPage()
    await page.route(`${origin}${base}`, route => route.fulfill({ contentType: 'text/html', body: '<!doctype html><title>性能計測</title>' }))
    await page.goto(`${origin}${base}`)
    const cdp = await context.newCDPSession(page)
    await cdp.send('Performance.enable')
    const errors: string[] = []
    page.on('pageerror', error => errors.push(error.message))
    const assets: { url: string; bytes: number }[] = []
    page.on('response', response => {
      if (/models\/|runtime\//.test(response.url())) assets.push({ url: new URL(response.url()).pathname, bytes: Number(response.headers()['content-length'] ?? 0) })
    })
    for (const cache of ['cold-context', 'warm-http-cache']) {
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
        rows.push({ ...row, latencies: distribution(row.latencies), cache, peakChromiumRssSumKiB: peakRssKiB,
          mainPageJsHeapUsedBytes: metrics.metrics.find(m => m.name === 'JSHeapUsedSize')?.value ?? null, assets: [...assets], errors: [...errors] })
        if (errors.length) throw new Error('Performance page errors')
        console.log(JSON.stringify({ seconds, cache, liveMs: row.liveMs, offlineMs: row.offlineMs, modelMs: row.modelMs, peakRssKiB }))
      } finally { clearInterval(monitor) }
    }
    await context.close()
  }
  writeFileSync(destination, JSON.stringify({ sourceHashes: sourceFingerprint(), environment: { node: process.version, browser: browser.version(), arch: process.arch },
    limitations: 'Unpaced sequential 1024-sample messages; round-trip service cost, not microphone latency. Includes first module load. RSS sum duplicates shared pages; heap excludes model worker. Cold browser context, warm OS/Vite cache. No real mobile or CPU throttle.', rows }, null, 2))
} finally { await browser.close(); await server.close() }
