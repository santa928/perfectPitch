import { test, expect } from '@playwright/test'
import { createPerformanceServer } from '../../scripts/evaluation/performance-server.ts'

test('性能計測serverは同じCache-Control資産の二回目をHTTP cacheから取得できる', async ({ browser }) => {
  const { server, requests, origin, base } = await createPerformanceServer()
  const context = await browser.newContext({ serviceWorkers: 'block' })
  try {
    const observations = []
    for (let iteration = 0; iteration < 2; iteration++) {
      const page = await context.newPage()
      await page.goto(`${origin}${base}`)
      observations.push(await page.evaluate(async (path) => {
        const response = await fetch(path), bytes = await response.arrayBuffer()
        const timing = performance.getEntriesByName(new URL(path, location.href).href)[0] as PerformanceResourceTiming
        return { size: bytes.byteLength, transferSize: timing.transferSize, encodedBodySize: timing.encodedBodySize }
      }, `${base}__cache-probe.bin`))
      await page.close()
    }
    expect(observations[0].size).toBe(4096)
    expect(observations[0].transferSize).toBeGreaterThan(4096)
    expect(observations[1]).toEqual({ size: 4096, transferSize: 0, encodedBodySize: 4096 })
    expect(requests).toHaveLength(1)
    expect(requests[0]).toMatchObject({ status: 200, bodyBytesWritten: 4096, cacheControl: 'public, max-age=3600' })
  } finally { await context.close(); await server.close() }
})
