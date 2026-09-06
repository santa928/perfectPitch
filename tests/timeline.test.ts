import { test } from 'node:test'
import assert from 'node:assert/strict'
import { noteLabel, plotBounds } from '../src/ui/timeline.ts'
test('low voice labels and plot edges stay within narrow mobile canvas', () => {
  assert.equal(noteLabel(33), 'A1')
  assert.equal(noteLabel(69.3), 'A4')
  const bounds = plotBounds(335, 350)
  assert.ok(bounds.right < 335 && bounds.bottom < 350)
  assert.ok(bounds.right > bounds.left && bounds.bottom > bounds.top)
})
