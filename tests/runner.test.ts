import assert from 'node:assert/strict'
import test from 'node:test'
import { shouldCallReplanner } from '../src/runner.ts'
import type { IStepResult } from '../src/types.ts'

const result = (overrides: Partial<IStepResult>): IStepResult => ({
  step: { id: 's1', description: 'd', expectedOutcome: 'e' },
  summary: 'ok',
  toolCalls: [],
  durationMs: 1,
  blocked: false,
  ...overrides,
})

test('shouldCallReplanner triggers when blocked is true', () => {
  assert.equal(shouldCallReplanner(result({ blocked: true })), true)
})

test('shouldCallReplanner triggers on any failed tool call', () => {
  assert.equal(
    shouldCallReplanner(
      result({ toolCalls: [{ name: 't', input: {}, output: 'err', ok: false }] }),
    ),
    true,
  )
})

test('shouldCallReplanner skips replanner on a clean step', () => {
  assert.equal(
    shouldCallReplanner(
      result({ toolCalls: [{ name: 't', input: {}, output: 'data', ok: true }] }),
    ),
    false,
  )
})

test('shouldCallReplanner ignores summary prose entirely (no language bias)', () => {
  // Previously a regex on the summary could miss non-English blockers; the
  // structural blocked flag is now the single source of truth.
  assert.equal(
    shouldCallReplanner(result({ summary: 'I cannot find the project anywhere.' })),
    false,
  )
})
