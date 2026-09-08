/** request routingを使わず計測HTMLを配信し、資産のサーバー送信を観測する。 */
import { createServer } from 'vite'

export interface AssetRequest { path: string; status: number; bodyBytesWritten: number; contentLength: number | null; cacheControl: string | null }

/** Viteの資産/cache方針は維持し、HTMLと回帰確認用cache資産だけを追加する。 */
export async function createPerformanceServer() {
  const requests: AssetRequest[] = []
  const server = await createServer({ server: { host: '127.0.0.1', port: 0 }, plugins: [{
    name: 'evaluation-performance-observation',
    configureServer(vite) {
      vite.middlewares.use((request, response, next) => {
        const path = new URL(request.url ?? '/', 'http://localhost').pathname
        if (/\/(models|runtime)\//.test(path) || path.endsWith('/__cache-probe.bin')) {
          let bodyBytesWritten = 0
          const count = (chunk: unknown, encoding: unknown): void => {
            if (typeof chunk === 'string') bodyBytesWritten += Buffer.byteLength(chunk, typeof encoding === 'string' ? encoding as BufferEncoding : undefined)
            else if (chunk instanceof Uint8Array) bodyBytesWritten += chunk.byteLength
          }
          const write = response.write, end = response.end
          response.write = function (this: typeof response, chunk: unknown, ...args: unknown[]) {
            count(chunk, args[0]); return Reflect.apply(write, this, [chunk, ...args])
          } as typeof response.write
          response.end = function (this: typeof response, chunk?: unknown, ...args: unknown[]) {
            count(chunk, args[0]); return Reflect.apply(end, this, [chunk, ...args])
          } as typeof response.end
          response.on('finish', () => requests.push({ path, status: response.statusCode, bodyBytesWritten,
            contentLength: response.hasHeader('Content-Length') ? Number(response.getHeader('Content-Length')) : null,
            cacheControl: response.hasHeader('Cache-Control') ? String(response.getHeader('Cache-Control')) : null }))
        }
        if (path === vite.config.base) {
          response.setHeader('Content-Type', 'text/html'); response.setHeader('Cache-Control', 'no-store')
          response.end('<!doctype html><title>性能計測</title>'); return
        }
        if (path === `${vite.config.base}__cache-probe.bin`) {
          const bytes = Buffer.alloc(4096, 71)
          response.setHeader('Content-Type', 'application/octet-stream')
          response.setHeader('Cache-Control', 'public, max-age=3600')
          response.setHeader('Content-Length', bytes.length); response.end(bytes); return
        }
        next()
      })
    },
  }] })
  await server.listen()
  const address = server.httpServer!.address()
  if (!address || typeof address === 'string') throw new Error('No server address')
  return { server, requests, origin: `http://127.0.0.1:${address.port}`, base: server.config.base }
}
