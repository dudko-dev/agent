import assert from 'node:assert/strict'
import test from 'node:test'
import { buildInstructions, cacheProviderOptions, resolvePromptCaching } from '../src/caching.ts'
import { stageCallOptions } from '../src/call-options.ts'
import {
  mergeProviderOptions,
  resolveThinking,
  stageEmitsThoughts,
  stageThinkingSetting,
} from '../src/thinking.ts'
import type { IAgentConfig } from '../src/types.ts'

test('resolveThinking: false / undefined send nothing', () => {
  assert.deepEqual(resolveThinking(undefined), {})
  assert.deepEqual(resolveThinking(false), {})
})

test("resolveThinking: true is 'medium' with thought streaming requested", () => {
  assert.deepEqual(resolveThinking(true), {
    reasoning: 'medium',
    providerOptions: {
      google: { thinkingConfig: { includeThoughts: true } },
      openai: { reasoningSummary: 'auto' },
    },
  })
})

test('resolveThinking: a bare level becomes { level }', () => {
  const r = resolveThinking('high')
  assert.equal(r.reasoning, 'high')
  assert.deepEqual(r.providerOptions?.openai, { reasoningSummary: 'auto' })
})

test("resolveThinking: 'none' disables explicitly and sends no provider options", () => {
  assert.deepEqual(resolveThinking('none'), { reasoning: 'none' })
  assert.deepEqual(resolveThinking({ level: 'none', budgetTokens: 2000 }), { reasoning: 'none' })
})

test('resolveThinking: budgetTokens maps to Anthropic and Google budgets', () => {
  assert.deepEqual(resolveThinking({ budgetTokens: 4096 }), {
    reasoning: 'medium',
    providerOptions: {
      anthropic: { thinking: { type: 'enabled', budgetTokens: 4096 } },
      google: { thinkingConfig: { thinkingBudget: 4096, includeThoughts: true } },
    },
  })
  const quiet = resolveThinking({ level: 'low', budgetTokens: 1024, includeThoughts: false })
  assert.equal(quiet.reasoning, 'low')
  assert.deepEqual(quiet.providerOptions?.google, {
    thinkingConfig: { thinkingBudget: 1024, includeThoughts: false },
  })
})

test('resolveThinking: includeThoughts false without a budget sends only the level', () => {
  assert.deepEqual(resolveThinking({ level: 'xhigh', includeThoughts: false }), {
    reasoning: 'xhigh',
  })
})

test('stageThinkingSetting: a stage entry (even false) wins over the top level', () => {
  const config = { thinking: 'high' as const, stageThinking: { executor: false as const } }
  assert.equal(stageThinkingSetting(config, 'planner'), 'high')
  assert.equal(stageThinkingSetting(config, 'executor'), false)
  assert.equal(stageEmitsThoughts({ thinking: { includeThoughts: false } }, 'synthesizer'), false)
  assert.equal(stageEmitsThoughts({}, 'synthesizer'), true)
})

test('mergeProviderOptions deep-merges per provider key, later layers win', () => {
  const merged = mergeProviderOptions(
    { google: { thinkingConfig: { includeThoughts: true } }, openai: { reasoningSummary: 'auto' } },
    undefined,
    { openai: { promptCacheKey: 'k' }, google: { thinkingConfig: { thinkingBudget: 5 } } },
  )
  assert.deepEqual(merged, {
    google: { thinkingConfig: { includeThoughts: true, thinkingBudget: 5 } },
    openai: { reasoningSummary: 'auto', promptCacheKey: 'k' },
  })
  assert.equal(mergeProviderOptions(undefined, undefined), undefined)
})

test('resolvePromptCaching: default on, false off, options carried', () => {
  assert.deepEqual(resolvePromptCaching(undefined), { enabled: true })
  assert.deepEqual(resolvePromptCaching(false), { enabled: false })
  assert.deepEqual(resolvePromptCaching({ ttl: '1h', key: 'x' }), {
    enabled: true,
    ttl: '1h',
    key: 'x',
  })
})

test('buildInstructions: a cache breakpoint on the system message when caching is on', () => {
  assert.equal(buildInstructions('SYS', { enabled: false }), 'SYS')
  assert.deepEqual(buildInstructions('SYS', { enabled: true, ttl: '1h' }), {
    role: 'system',
    content: 'SYS',
    providerOptions: { anthropic: { cacheControl: { type: 'ephemeral', ttl: '1h' } } },
  })
  assert.deepEqual(cacheProviderOptions({ enabled: true }, 'app', 'executor'), {
    openai: { promptCacheKey: 'app:executor' },
  })
  assert.equal(cacheProviderOptions({ enabled: false }, 'app', 'executor'), undefined)
})

const config = (extra: Partial<IAgentConfig> = {}): IAgentConfig => ({
  clientName: 'app',
  providerType: 'openai',
  apiKey: 'k',
  model: 'm',
  mcpServers: {},
  maxIterations: 1,
  maxStepsPerTask: 1,
  logLevel: 'none',
  ...extra,
})

test('stageCallOptions merges thinking + caching and applies the per-call cap', () => {
  const call = stageCallOptions(
    config({
      thinking: 'low',
      stageThinking: { planner: { budgetTokens: 2048 } },
      limits: { perCall: { planner: 900 } },
      promptCaching: { key: 'fixed' },
    }),
    'planner',
    'PLANNER SYSTEM',
  )
  assert.equal(call.reasoning, 'medium')
  assert.equal(call.maxOutputTokens, 900)
  assert.deepEqual(call.providerOptions?.openai, { promptCacheKey: 'fixed' })
  assert.deepEqual(call.providerOptions?.anthropic, {
    thinking: { type: 'enabled', budgetTokens: 2048 },
  })
  assert.equal(typeof call.instructions, 'object')

  // Defaults: no thinking, no cap, caching on.
  const plain = stageCallOptions(config(), 'executor', 'EXEC')
  assert.equal(plain.reasoning, undefined)
  assert.equal(plain.maxOutputTokens, undefined)
  assert.deepEqual(plain.providerOptions, { openai: { promptCacheKey: 'app:executor' } })

  const uncached = stageCallOptions(config({ promptCaching: false }), 'synthesizer', 'S')
  assert.equal(uncached.instructions, 'S')
  assert.equal(uncached.providerOptions, undefined)
})
