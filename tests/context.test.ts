import assert from 'node:assert/strict'
import test from 'node:test'
import { getCurrentRunId, runContext } from '../src/context.ts'

test('getCurrentRunId is undefined outside of a run context', () => {
  assert.equal(getCurrentRunId(), undefined)
})

test('getCurrentRunId reflects the active store inside runContext.run', () => {
  runContext.run({ runId: 'abc-123', startedAt: 0 }, () => {
    assert.equal(getCurrentRunId(), 'abc-123')
  })
})

test('runContext isolates concurrent runs across awaits', async () => {
  const runOnce = (id: string, delay: number): Promise<string | undefined> =>
    runContext.run({ runId: id, startedAt: 0 }, async () => {
      await new Promise((r) => setTimeout(r, delay))
      return getCurrentRunId()
    })

  const [a, b] = await Promise.all([runOnce('a', 15), runOnce('b', 5)])
  assert.equal(a, 'a')
  assert.equal(b, 'b')
})
