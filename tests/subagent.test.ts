import assert from 'node:assert/strict'
import test from 'node:test'
import {
  assertWorkerSafeConfig,
  slimEvent,
  subagentWorkerUrl,
  toCloneable,
  workerExecArgv,
} from '../src/subagent.ts'
import type { IAgentConfig } from '../src/types.ts'

const config = (extra: Partial<IAgentConfig> = {}): IAgentConfig => ({
  clientName: 'c',
  providerType: 'openai',
  apiKey: 'k',
  model: 'm',
  mcpServers: {},
  maxIterations: 1,
  maxStepsPerTask: 1,
  logLevel: 'none',
  ...extra,
})

test('assertWorkerSafeConfig names the first function-valued field', () => {
  assert.doesNotThrow(() => assertWorkerSafeConfig(config({ thinking: 'high' })))
  assert.throws(
    () =>
      assertWorkerSafeConfig(
        config({ mcpServers: { docs: { url: 'https://x', getHeaders: () => ({}) } } }),
      ),
    /config\.mcpServers\.docs\.getHeaders is a function/,
  )
  assert.throws(
    () =>
      assertWorkerSafeConfig(config({ toolApproval: { mode: 'ask-all', onRequest: () => true } })),
    /config\.toolApproval\.onRequest/,
  )
})

test('workerExecArgv keeps runtime flags and drops the entry-point ones', () => {
  assert.deepEqual(
    workerExecArgv([
      '--experimental-strip-types',
      '--input-type=module',
      '-e',
      'code()',
      '--disable-warning=ExperimentalWarning',
      '--input-type',
      'commonjs',
    ]),
    ['--experimental-strip-types', '--disable-warning=ExperimentalWarning'],
  )
})

test('toCloneable / slimEvent: Errors become messages only when cloning fails; long strings clipped', () => {
  const withFn = { a: 1, f: () => 1, e: new Error('boom') }
  assert.deepEqual(toCloneable(withFn), { a: 1, e: 'boom' })
  assert.deepEqual(toCloneable({ a: [1, 'x'] }), { a: [1, 'x'] })
  const slim = slimEvent({
    type: 'step.tool-result',
    step: { id: 's', description: 'd', expectedOutcome: 'e' },
    name: 't',
    output: 'z'.repeat(10_000),
    ok: true,
  }) as { output: string }
  assert.ok(slim.output.length < 5_000)
  assert.match(slim.output, /… \[truncated 6000 chars\]$/)
})

test('subagentWorkerUrl points at the .ts entry from source', () => {
  assert.match(subagentWorkerUrl().pathname, /\/src\/subagent-worker\.ts$/)
})
