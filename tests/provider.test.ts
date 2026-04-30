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

// Providers exercised via the dynamic-import path. We pick ones whose SDKs
// construct a model from { apiKey, model } alone (no extra required field
// like resourceName / accountId), so the test stays self-contained.
const PROVIDERS: ProviderType[] = [
  'openai',
  'anthropic',
  'google',
  'xai',
  'amazon-bedrock',
  'deepseek',
  'gateway',
]

for (const providerType of PROVIDERS) {
  test(`buildModelFromStage returns a model object for provider=${providerType}`, async () => {
    const model = await buildModelFromStage('test', {
      providerType,
      apiKey: 'k',
      model: 'some-model',
    })
    assert.ok(model, 'expected a non-null model')
  })
}

test('buildModelFromStage for google-vertex builds with project + location env vars', async () => {
  // Vertex resolves project / location lazily from env; set them so the
  // factory can synthesize a baseURL without contacting Google ADC.
  const envBackup = {
    project: process.env.GOOGLE_VERTEX_PROJECT,
    location: process.env.GOOGLE_VERTEX_LOCATION,
  }
  process.env.GOOGLE_VERTEX_PROJECT = 'test-project'
  process.env.GOOGLE_VERTEX_LOCATION = 'us-central1'
  try {
    const model = await buildModelFromStage('test', {
      providerType: 'google-vertex',
      apiKey: 'k',
      model: 'gemini-2.0-flash',
    })
    assert.ok(model)
  } finally {
    if (envBackup.project === undefined) {
      delete process.env.GOOGLE_VERTEX_PROJECT
    } else {
      process.env.GOOGLE_VERTEX_PROJECT = envBackup.project
    }
    if (envBackup.location === undefined) {
      delete process.env.GOOGLE_VERTEX_LOCATION
    } else {
      process.env.GOOGLE_VERTEX_LOCATION = envBackup.location
    }
  }
})

test('buildModelFromStage for openai-compatible requires baseURL', async () => {
  await assert.rejects(
    () =>
      buildModelFromStage('test', { providerType: 'openai-compatible', apiKey: 'k', model: 'm' }),
    /openai-compatible.*baseURL/,
  )
})

test('buildModelFromStage for openai-compatible accepts a baseURL', async () => {
  const model = await buildModelFromStage('test', {
    providerType: 'openai-compatible',
    apiKey: 'k',
    baseURL: 'https://x.example/v1',
    model: 'm',
  })
  assert.ok(model)
})

test('buildModelFromStage for azure accepts a baseURL', async () => {
  const model = await buildModelFromStage('test', {
    providerType: 'azure',
    apiKey: 'k',
    baseURL: 'https://x.openai.azure.com',
    model: 'm',
  })
  assert.ok(model)
})

test('buildModelFromStage for cloudflare requires accountId from providerOptions or env', async () => {
  const prev = process.env.CLOUDFLARE_ACCOUNT_ID
  delete process.env.CLOUDFLARE_ACCOUNT_ID
  try {
    await assert.rejects(
      () => buildModelFromStage('test', { providerType: 'cloudflare', apiKey: 'k', model: 'm' }),
      /accountId/,
    )
  } finally {
    if (prev !== undefined) {
      process.env.CLOUDFLARE_ACCOUNT_ID = prev
    }
  }
})

test('buildModelFromStage for cloudflare uses CLOUDFLARE_ACCOUNT_ID env fallback', async () => {
  const prev = process.env.CLOUDFLARE_ACCOUNT_ID
  process.env.CLOUDFLARE_ACCOUNT_ID = 'acc-env'
  try {
    const model = await buildModelFromStage('test', {
      providerType: 'cloudflare',
      apiKey: 'k',
      model: '@cf/meta/llama-3.1-8b-instruct',
    })
    assert.ok(model)
  } finally {
    if (prev === undefined) {
      delete process.env.CLOUDFLARE_ACCOUNT_ID
    } else {
      process.env.CLOUDFLARE_ACCOUNT_ID = prev
    }
  }
})

test('buildModelFromStage for cloudflare prefers providerOptions.accountId over env', async () => {
  const prev = process.env.CLOUDFLARE_ACCOUNT_ID
  delete process.env.CLOUDFLARE_ACCOUNT_ID
  try {
    const model = await buildModelFromStage('test', {
      providerType: 'cloudflare',
      apiKey: 'k',
      model: '@cf/meta/llama-3.1-8b-instruct',
      providerOptions: { accountId: 'acc-from-options' },
    })
    assert.ok(model)
  } finally {
    if (prev !== undefined) {
      process.env.CLOUDFLARE_ACCOUNT_ID = prev
    }
  }
})

test('resolveStage falls through to top-level defaults when no override is given', () => {
  const c = baseConfig({ baseURL: 'https://api.example' })
  const r = resolveStage(c, undefined, undefined, 'planner')
  assert.deepEqual(r, {
    providerType: 'openai',
    baseURL: 'https://api.example',
    apiKey: 'sk-test',
    model: 'm',
    providerOptions: {},
  })
})

test('resolveStage inherits providerOptions from the top-level config', () => {
  const c = baseConfig({ providerOptions: { region: 'us-east-1' } })
  const r = resolveStage(c, undefined, undefined, 'executor')
  assert.deepEqual(r.providerOptions, { region: 'us-east-1' })
})

test('resolveStage replaces providerOptions when the override block defines its own', () => {
  const c = baseConfig({ providerOptions: { region: 'us-east-1' } })
  const r = resolveStage(
    c,
    { providerOptions: { region: 'eu-west-1', maxRetries: 3 } },
    undefined,
    'planner',
  )
  // We REPLACE rather than merge - matches how baseURL/apiKey work.
  assert.deepEqual(r.providerOptions, { region: 'eu-west-1', maxRetries: 3 })
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
