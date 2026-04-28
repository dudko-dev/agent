import assert from 'node:assert/strict'
import test from 'node:test'
import { resolveResume, shouldCallReplanner } from '../src/runner.ts'
import type { IAgentInternalContext } from '../src/internal.ts'
import type { IAgentConfig, IPersistence, IRunSnapshot, IStepResult } from '../src/types.ts'

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

const baseConfig = (overrides: Partial<IAgentConfig> = {}): IAgentConfig => ({
  clientName: 't',
  providerType: 'openai',
  apiKey: 'k',
  model: 'm',
  mcpServers: {},
  maxIterations: 3,
  maxStepsPerTask: 2,
  logLevel: 'none',
  ...overrides,
})

const ctxWith = (config: IAgentConfig): IAgentInternalContext => ({
  config,
  tools: {},
  toolCatalog: [],
  emit: () => {},
  executorModel: {} as IAgentInternalContext['executorModel'],
  plannerModel: {} as IAgentInternalContext['plannerModel'],
  synthesizerModel: {} as IAgentInternalContext['synthesizerModel'],
})

const sampleSnapshot = (overrides: Partial<IRunSnapshot> = {}): IRunSnapshot => ({
  runId: 'r-original',
  startedAt: 1_000,
  status: 'executing',
  input: 'do thing',
  trace: [],
  usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
  stepIndex: 0,
  iterations: 0,
  revisions: 0,
  plan: { thought: 'go', steps: [{ id: 's1', description: 'd', expectedOutcome: 'e' }] },
  ...overrides,
})

test('resolveResume returns undefined when no resumeFromRunId is set', async () => {
  const r = await resolveResume(ctxWith(baseConfig()), { input: 'x' })
  assert.equal(r, undefined)
})

test('resolveResume throws when persistence is missing', async () => {
  await assert.rejects(
    () => resolveResume(ctxWith(baseConfig()), { input: 'x', resumeFromRunId: 'r1' }),
    /loadRun/,
  )
})

test('resolveResume throws when persistence has no loadRun', async () => {
  const persistence: IPersistence = { onRunStart: () => {} }
  await assert.rejects(
    () =>
      resolveResume(ctxWith(baseConfig({ persistence })), { input: 'x', resumeFromRunId: 'r1' }),
    /loadRun/,
  )
})

test('resolveResume throws when the snapshot is not found', async () => {
  const persistence: IPersistence = { loadRun: () => null }
  await assert.rejects(
    () =>
      resolveResume(ctxWith(baseConfig({ persistence })), { input: 'x', resumeFromRunId: 'r1' }),
    /No persisted run found/,
  )
})

test('resolveResume rejects a complete snapshot (cannot resume from terminal)', async () => {
  const persistence: IPersistence = {
    loadRun: () => sampleSnapshot({ status: 'complete', text: 'done' }),
  }
  await assert.rejects(
    () =>
      resolveResume(ctxWith(baseConfig({ persistence })), { input: 'x', resumeFromRunId: 'r1' }),
    /already complete/,
  )
})

test('resolveResume rejects a snapshot with no plan', async () => {
  const persistence: IPersistence = {
    loadRun: () => sampleSnapshot({ status: 'planning', plan: undefined }),
  }
  await assert.rejects(
    () =>
      resolveResume(ctxWith(baseConfig({ persistence })), { input: 'x', resumeFromRunId: 'r1' }),
    /no saved plan/,
  )
})

test('resolveResume returns the snapshot for a resumable status (failed)', async () => {
  const snapshot = sampleSnapshot({
    status: 'failed',
    error: 'network',
    iterations: 2,
    stepIndex: 1,
  })
  const persistence: IPersistence = { loadRun: () => snapshot }
  const r = await resolveResume(ctxWith(baseConfig({ persistence })), {
    input: 'x',
    resumeFromRunId: 'r-original',
  })
  assert.equal(r?.runId, 'r-original')
  assert.equal(r?.iterations, 2)
  assert.equal(r?.stepIndex, 1)
})

test('resolveResume awaits a Promise returned by loadRun', async () => {
  const snapshot = sampleSnapshot({ status: 'cancelled' })
  const persistence: IPersistence = {
    loadRun: async () => {
      await new Promise((res) => setTimeout(res, 5))
      return snapshot
    },
  }
  const r = await resolveResume(ctxWith(baseConfig({ persistence })), {
    input: 'x',
    resumeFromRunId: 'r-original',
  })
  assert.equal(r?.runId, 'r-original')
  assert.equal(r?.status, 'cancelled')
})
