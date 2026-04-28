import assert from 'node:assert/strict'
import test from 'node:test'
import { buildModel } from '../src/provider.ts'
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
  test(`buildModel returns a model object for provider=${providerType}`, () => {
    const model = buildModel(baseConfig({ providerType }), 'some-model')
    assert.ok(model, 'expected a non-null model')
  })
}

test('buildModel for openai-compatible requires baseURL', () => {
  assert.throws(
    () => buildModel(baseConfig({ providerType: 'openai-compatible' }), 'm'),
    /openai-compatible.*baseURL/,
  )
})

test('buildModel for openai-compatible accepts a baseURL', () => {
  const model = buildModel(
    baseConfig({ providerType: 'openai-compatible', baseURL: 'https://x.example/v1' }),
    'm',
  )
  assert.ok(model)
})
