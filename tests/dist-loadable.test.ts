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
