import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import test from 'node:test'

// These tests guard against the day an upstream dep (ai, @ai-sdk/*,
// @modelcontextprotocol/sdk) drops its CJS fallback and our dual-format
// promise quietly breaks. Skipped when dist/ has not been built yet so
// `npm test` works on a clean checkout.
const HAS_CJS = existsSync('./dist/index.cjs')
const HAS_ESM = existsSync('./dist/index.js')
const HAS_WORKER = existsSync('./dist/subagent-worker.js')

test('dist/index.cjs is require()-able as CommonJS', { skip: !HAS_CJS }, () => {
  const out = execFileSync(
    'node',
    [
      '-e',
      "const m = require('./dist/index.cjs'); process.stdout.write(JSON.stringify(Object.keys(m).sort()))",
    ],
    { encoding: 'utf8' },
  )
  const keys = JSON.parse(out)
  assert.ok(keys.includes('createAgent'))
  assert.ok(keys.includes('getCurrentRunId'))
})

test('dist/index.js is import()-able as ESM', { skip: !HAS_ESM }, () => {
  const out = execFileSync(
    'node',
    [
      '--input-type=module',
      '-e',
      "import('./dist/index.js').then(m => process.stdout.write(JSON.stringify(Object.keys(m).sort())))",
    ],
    { encoding: 'utf8' },
  )
  const keys = JSON.parse(out)
  assert.ok(keys.includes('createAgent'))
  assert.ok(keys.includes('getCurrentRunId'))
})

// createSubagentTool({ isolation: 'worker' }) resolves this entry next to
// the bundle; it must exist and load in a worker thread without crashing.
test('dist/subagent-worker.js loads in a worker thread', { skip: !HAS_ESM }, () => {
  assert.ok(HAS_WORKER, 'dist/subagent-worker.js is built alongside dist/index.js')
  const out = execFileSync(
    'node',
    [
      '--input-type=module',
      '-e',
      `import { Worker } from 'node:worker_threads'
       const w = new Worker(new URL('./dist/subagent-worker.js', 'file://' + process.cwd() + '/'), { execArgv: [] })
       w.on('error', (e) => { console.error(e); process.exit(1) })
       w.on('online', () => setTimeout(() => w.terminate().then(() => process.stdout.write('ok')), 200))`,
    ],
    { encoding: 'utf8' },
  )
  assert.equal(out, 'ok')
})

test('dist/index.cjs resolves the worker entry through import.meta.url', { skip: !HAS_CJS }, () => {
  const out = execFileSync(
    'node',
    [
      '-e',
      "const m = require('./dist/index.cjs'); const t = m.createSubagentTool({ name: 'x', description: 'x', config: { clientName: 'c', providerType: 'openai', apiKey: 'k', model: 'm', mcpServers: {}, maxIterations: 1, maxStepsPerTask: 1, logLevel: 'none' } }); process.stdout.write(typeof t.execute)",
    ],
    { encoding: 'utf8' },
  )
  assert.equal(out, 'function')
})
