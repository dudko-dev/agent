import assert from 'node:assert/strict'
import test from 'node:test'
import { buildActiveToolSet, splitBlockerSentinel } from '../src/executor.ts'
import type { IAgentInternalContext } from '../src/internal.ts'
import type { IAgentConfig, IPlanStep } from '../src/types.ts'

const baseConfig: IAgentConfig = {
  clientName: 't',
  providerType: 'openai',
  apiKey: 'k',
  model: 'm',
  mcpServers: {},
  maxIterations: 1,
  maxStepsPerTask: 1,
  logLevel: 'none',
}

const stubCtx = (config: IAgentConfig, tools: Record<string, unknown>): IAgentInternalContext => ({
  config,
  tools: tools as IAgentInternalContext['tools'],
  toolCatalog: [],
  emit: () => {},
  executorModel: {} as IAgentInternalContext['executorModel'],
  plannerModel: {} as IAgentInternalContext['plannerModel'],
  synthesizerModel: {} as IAgentInternalContext['synthesizerModel'],
})

const step = (overrides: Partial<IPlanStep>): IPlanStep => ({
  id: 's1',
  description: 'do thing',
  expectedOutcome: 'thing done',
  ...overrides,
})

test('splitBlockerSentinel detects [BLOCKER] and strips it from summary', () => {
  const r = splitBlockerSentinel('Cannot find the project.\n[BLOCKER]')
  assert.equal(r.blocked, true)
  assert.equal(r.summary, 'Cannot find the project.')
})

test('splitBlockerSentinel works with sentinel mid-text', () => {
  const r = splitBlockerSentinel('Foo\n[BLOCKER]\nbar')
  assert.equal(r.blocked, true)
  assert.equal(r.summary, 'Foo\n\nbar'.trim())
})

test('splitBlockerSentinel is language-independent (no English regex bias)', () => {
  // The whole point of structural detection: a Russian summary still triggers.
  const r = splitBlockerSentinel('Не могу найти инструмент. [BLOCKER]')
  assert.equal(r.blocked, true)
  assert.ok(r.summary.startsWith('Не могу найти инструмент'))
})

test('splitBlockerSentinel returns blocked=false without sentinel', () => {
  const r = splitBlockerSentinel('Step done; found 3 records.')
  assert.equal(r.blocked, false)
  assert.equal(r.summary, 'Step done; found 3 records.')
})

test('buildActiveToolSet returns full tools in "all" mode', () => {
  const tools = { a__x: {}, a__y: {} }
  const ctx = stubCtx({ ...baseConfig, toolSelectionStrategy: 'all' }, tools)
  const out = buildActiveToolSet(ctx, step({ suggestedTools: ['a__x'] }))
  assert.deepEqual(Object.keys(out).sort(), ['a__x', 'a__y'])
})

test('buildActiveToolSet narrows to suggestedTools in "plan-narrowed" mode', () => {
  const tools = { a__x: { _: 1 }, a__y: { _: 2 } }
  const ctx = stubCtx({ ...baseConfig, toolSelectionStrategy: 'plan-narrowed' }, tools)
  const out = buildActiveToolSet(ctx, step({ suggestedTools: ['a__x'] }))
  assert.deepEqual(Object.keys(out), ['a__x'])
})

test('buildActiveToolSet returns empty for reasoning-only step in narrowed mode', () => {
  const tools = { a__x: {}, a__y: {} }
  const ctx = stubCtx({ ...baseConfig, toolSelectionStrategy: 'plan-narrowed' }, tools)
  const out = buildActiveToolSet(ctx, step({ suggestedTools: undefined }))
  assert.deepEqual(Object.keys(out), [])
})

test('buildActiveToolSet falls back to full toolset when requiresTools is set', () => {
  const tools = { a__x: {}, a__y: {} }
  const ctx = stubCtx({ ...baseConfig, toolSelectionStrategy: 'plan-narrowed' }, tools)
  const out = buildActiveToolSet(ctx, step({ suggestedTools: undefined, requiresTools: true }))
  assert.deepEqual(Object.keys(out).sort(), ['a__x', 'a__y'])
})

test('buildActiveToolSet drops unknown tool names silently from suggestedTools', () => {
  const tools = { a__x: {} }
  const ctx = stubCtx({ ...baseConfig, toolSelectionStrategy: 'plan-narrowed' }, tools)
  const out = buildActiveToolSet(ctx, step({ suggestedTools: ['a__x', 'a__missing'] }))
  assert.deepEqual(Object.keys(out), ['a__x'])
})
