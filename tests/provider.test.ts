import assert from 'node:assert/strict'
import test from 'node:test'
import { buildModelFromStage, resolveStage } from '../src/provider.ts'
import type { IAgentConfig, ProviderType } from '../src/types.ts'

const baseConfig = (overrides: Partial<IAgentConfig> = {}): IAgentConfig => ({
  clientName: 'test',
  providerType: 'openai',
  apiKey: 'sk-test',
  model: 'm',
  mcpServers: {},
  maxIterations: 1,
  maxStepsPerTask: 1,
  logLevel: 'none',
  ...overrides,
})

const PROVIDERS: ProviderType[] = ['openai', 'anthropic', 'google']

for (const providerType of PROVIDERS) {
  test(`buildModelFromStage returns a model object for provider=${providerType}`, () => {
    const model = buildModelFromStage('test', {
      providerType,
      apiKey: 'k',
      model: 'some-model',
    })
    assert.ok(model, 'expected a non-null model')
  })
}

test('buildModelFromStage for openai-compatible requires baseURL', () => {
  assert.throws(
    () =>
      buildModelFromStage('test', { providerType: 'openai-compatible', apiKey: 'k', model: 'm' }),
    /openai-compatible.*baseURL/,
  )
})

test('buildModelFromStage for openai-compatible accepts a baseURL', () => {
  const model = buildModelFromStage('test', {
    providerType: 'openai-compatible',
    apiKey: 'k',
    baseURL: 'https://x.example/v1',
    model: 'm',
  })
  assert.ok(model)
})

test('resolveStage falls through to top-level defaults when no override is given', () => {
  const c = baseConfig({ baseURL: 'https://api.example' })
  const r = resolveStage(c, undefined, undefined, 'planner')
  assert.deepEqual(r, {
    providerType: 'openai',
    baseURL: 'https://api.example',
    apiKey: 'sk-test',
    model: 'm',
  })
})

test('resolveStage applies override fields field-by-field', () => {
  const c = baseConfig()
  const r = resolveStage(c, { model: 'gpt-5-mini' }, undefined, 'planner')
  assert.equal(r.model, 'gpt-5-mini')
  assert.equal(r.providerType, 'openai')
  assert.equal(r.apiKey, 'sk-test')
})

test('resolveStage prefers override.model over the legacy single-string model', () => {
  const r = resolveStage(baseConfig(), { model: 'block' }, 'legacy', 'planner')
  assert.equal(r.model, 'block')
})

test('resolveStage falls back to legacy single-string model when override.model is absent', () => {
  const r = resolveStage(baseConfig(), { providerType: 'openai' }, 'legacy', 'planner')
  assert.equal(r.model, 'legacy')
})

test('resolveStage rejects cross-provider override without apiKey', () => {
  const c = baseConfig({ providerType: 'openai' })
  assert.throws(
    () => resolveStage(c, { providerType: 'anthropic' }, undefined, 'planner'),
    /cross-provider/,
  )
})

test('resolveStage accepts cross-provider override with explicit apiKey', () => {
  const c = baseConfig({ providerType: 'openai' })
  const r = resolveStage(
    c,
    { providerType: 'anthropic', apiKey: 'sk-anthro' },
    undefined,
    'planner',
  )
  assert.equal(r.providerType, 'anthropic')
  assert.equal(r.apiKey, 'sk-anthro')
})

test('resolveStage requires baseURL for openai-compatible at the resolved level', () => {
  const c = baseConfig({ providerType: 'openai' })
  assert.throws(
    () =>
      resolveStage(
        c,
        { providerType: 'openai-compatible', apiKey: 'sk', model: 'm' },
        undefined,
        'planner',
      ),
    /openai-compatible.*baseURL/,
  )
})
