import { copyFile, mkdir, readFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const packageRoot = resolve(projectRoot, 'node_modules/onnxruntime-web')
const packageData = JSON.parse(
  await readFile(resolve(packageRoot, 'package.json'), 'utf8'),
)

if (packageData.version !== '1.29.0') {
  throw new Error(
    `onnxruntime-web 1.29.0 is required, found ${String(packageData.version)}`,
  )
}

const runtimeDirectory = resolve(projectRoot, 'public/runtime')
await mkdir(runtimeDirectory, { recursive: true })
for (const name of [
  'ort.wasm.min.mjs',
  'ort-wasm-simd-threaded.mjs',
  'ort-wasm-simd-threaded.wasm',
]) {
  await copyFile(
    resolve(packageRoot, 'dist', name),
    resolve(runtimeDirectory, name),
  )
}
