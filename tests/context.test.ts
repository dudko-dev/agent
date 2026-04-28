import assert from 'node:assert/strict'
import test from 'node:test'
import { getCurrentRunId, getCurrentRunSandbox, runContext } from '../src/context.ts'

test('getCurrentRunId is undefined outside of a run context', () => {
  assert.equal(getCurrentRunId(), undefined)
})

test('getCurrentRunSandbox is undefined outside of a run context', () => {
  assert.equal(getCurrentRunSandbox(), undefined)
})

test('getCurrentRunId reflects the active store inside runContext.run', () => {
  runContext.run({ runId: 'abc-123', startedAt: 0, sandboxDir: '/tmp/x' }, () => {
    assert.equal(getCurrentRunId(), 'abc-123')
  })
})

test('getCurrentRunSandbox reflects the active store inside runContext.run', () => {
  runContext.run({ runId: 'r1', startedAt: 0, sandboxDir: '/tmp/agent-sandbox/r1' }, () => {
    assert.equal(getCurrentRunSandbox(), '/tmp/agent-sandbox/r1')
  })
})

test('runContext isolates concurrent runs across awaits', async () => {
  const runOnce = (
    id: string,
    delay: number,
  ): Promise<{ runId: string | undefined; sandbox: string | undefined }> =>
    runContext.run(
      { runId: id, startedAt: 0, sandboxDir: `/tmp/agent-sandbox/${id}` },
      async () => {
        await new Promise((r) => setTimeout(r, delay))
        return { runId: getCurrentRunId(), sandbox: getCurrentRunSandbox() }
      },
    )

  const [a, b] = await Promise.all([runOnce('a', 15), runOnce('b', 5)])
  assert.equal(a.runId, 'a')
  assert.equal(b.runId, 'b')
  // Sandbox isolation: each run sees its own subdir even when the awaits
  // interleave on the event loop.
  assert.equal(a.sandbox, '/tmp/agent-sandbox/a')
  assert.equal(b.sandbox, '/tmp/agent-sandbox/b')
})
