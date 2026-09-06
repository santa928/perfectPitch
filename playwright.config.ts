import { defineConfig } from '@playwright/test'
import { resolve } from 'node:path'
export default defineConfig({
  testDir: './tests/browser',
  timeout: 45000,
  expect: { timeout: 10000 },
  fullyParallel: false,
  workers: 1,
  reporter: [['list'], ['json', { outputFile: 'output/browser-results.json' }]],
  use: {
    baseURL: 'http://127.0.0.1:4173/perfectPitch/',
    screenshot: 'only-on-failure',
    trace: 'retain-on-failure',
    launchOptions: {
      args: [
        '--use-fake-device-for-media-stream',
        '--use-fake-ui-for-media-stream',
        `--use-file-for-fake-audio-capture=${resolve('output/test-voice.wav')}`,
      ],
    },
  },
  webServer: {
    command:
      process.env.TEST_PREVIEW === '1'
        ? 'npm run preview -- --host 0.0.0.0 --port 4173'
        : 'npm run dev -- --host 0.0.0.0 --port 4173',
    url: 'http://127.0.0.1:4173/perfectPitch/',
    reuseExistingServer: true,
  },
  outputDir: 'output/browser-artifacts',
})
