import assert from 'node:assert/strict'
import test, { beforeEach } from 'node:test'
import { loadConfig } from '../src/cli/config.ts'

const CONFIG_KEYS = [
  'AGENT_PROVIDER_TYPE',
  'AGENT_API_KEY',
  'AGENT_MODEL',
  'AGENT_BASE_URL',
  'AGENT_PLANNER_MODEL',
  'AGENT_SYNTHESIZER_MODEL',
  'AGENT_CLIENT_NAME',
  'MCP_SERVERS',
  'AGENT_AVAILABLE_TOOLS',
  'AGENT_EXCLUDED_TOOLS',
  'AGENT_MAX_ITERATIONS',
  'AGENT_MAX_STEPS_PER_TASK',
  'AGENT_MAX_REVISIONS',
  'AGENT_MAX_TOTAL_TOKENS',
  'AGENT_LLM_TIMEOUT_MS',
  'AGENT_LLM_MAX_RETRIES',
  'AGENT_TOOL_SELECTION_STRATEGY',
  'AGENT_LOG_LEVEL',
] as const

beforeEach(() => {
  for (const k of CONFIG_KEYS) {
    delete process.env[k]
  }
})

const setMinimalOpenAi = (): void => {
  process.env.AGENT_PROVIDER_TYPE = 'openai'
  process.env.AGENT_API_KEY = 'sk-test'
  process.env.AGENT_MODEL = 'gpt-4'
}

test('loadConfig throws when AGENT_API_KEY is missing', () => {
  process.env.AGENT_PROVIDER_TYPE = 'openai'
  process.env.AGENT_MODEL = 'gpt-4'
  assert.throws(() => loadConfig(), /AGENT_API_KEY/)
})

test('loadConfig parses a minimal openai config with safe defaults', () => {
  setMinimalOpenAi()
  const c = loadConfig()
  assert.equal(c.providerType, 'openai')
  assert.equal(c.apiKey, 'sk-test')
  assert.equal(c.model, 'gpt-4')
  assert.equal(c.baseURL, undefined)
  assert.equal(c.logLevel, 'info')
  assert.equal(c.clientName, 'vercel-mcp-test')
  assert.deepEqual(c.mcpServers, {})
  assert.equal(c.availableTools, undefined)
  assert.equal(c.excludedTools, undefined)
})

test('loadConfig requires AGENT_BASE_URL for openai-compatible', () => {
  process.env.AGENT_PROVIDER_TYPE = 'openai-compatible'
  process.env.AGENT_API_KEY = 'k'
  process.env.AGENT_MODEL = 'm'
  assert.throws(() => loadConfig(), /AGENT_BASE_URL/)
})

test('loadConfig accepts openai-compatible with baseURL', () => {
  process.env.AGENT_PROVIDER_TYPE = 'openai-compatible'
  process.env.AGENT_API_KEY = 'k'
  process.env.AGENT_MODEL = 'm'
  process.env.AGENT_BASE_URL = 'https://internal.example/v1'
  const c = loadConfig()
  assert.equal(c.providerType, 'openai-compatible')
  assert.equal(c.baseURL, 'https://internal.example/v1')
})

test('loadConfig rejects unknown provider type', () => {
  process.env.AGENT_PROVIDER_TYPE = 'mystery'
  process.env.AGENT_API_KEY = 'k'
  process.env.AGENT_MODEL = 'm'
  assert.throws(() => loadConfig(), /AGENT_PROVIDER_TYPE/)
})

test('loadConfig rejects unknown log level', () => {
  setMinimalOpenAi()
  process.env.AGENT_LOG_LEVEL = 'verbose'
  assert.throws(() => loadConfig(), /AGENT_LOG_LEVEL/)
})

test('loadConfig parses MCP_SERVERS JSON', () => {
  setMinimalOpenAi()
  process.env.MCP_SERVERS = JSON.stringify({
    docs: { url: 'https://x', headers: { Authorization: 'Bearer t' } },
  })
  const c = loadConfig()
  assert.deepEqual(c.mcpServers.docs, {
    url: 'https://x',
    headers: { Authorization: 'Bearer t' },
  })
})

test('loadConfig rejects malformed MCP_SERVERS JSON', () => {
  setMinimalOpenAi()
  process.env.MCP_SERVERS = '{ not json'
  assert.throws(() => loadConfig(), /MCP_SERVERS/)
})

test('loadConfig rejects MCP_SERVERS entry without url or command', () => {
  setMinimalOpenAi()
  process.env.MCP_SERVERS = JSON.stringify({ docs: { headers: {} } })
  assert.throws(() => loadConfig(), /must specify "url" .*"command"/)
})

test('loadConfig parses MCP_SERVERS stdio config (command + args + env)', () => {
  setMinimalOpenAi()
  process.env.MCP_SERVERS = JSON.stringify({
    fs: { command: '/usr/local/bin/mcp-fs', args: ['--root', '/tmp'], env: { DEBUG: '1' } },
  })
  const c = loadConfig()
  const fs = c.mcpServers.fs as { command: string; args: string[]; env: Record<string, string> }
  assert.equal(fs.command, '/usr/local/bin/mcp-fs')
  assert.deepEqual(fs.args, ['--root', '/tmp'])
  assert.deepEqual(fs.env, { DEBUG: '1' })
})

test('loadConfig rejects MCP_SERVERS entry that mixes url and command', () => {
  setMinimalOpenAi()
  process.env.MCP_SERVERS = JSON.stringify({
    weird: { url: 'http://x', command: '/bin/x' },
  })
  assert.throws(() => loadConfig(), /not both/)
})

test('loadConfig parses CSV tool lists, trimming and dropping empties', () => {
  setMinimalOpenAi()
  process.env.AGENT_AVAILABLE_TOOLS = 'a, b ,c, '
  process.env.AGENT_EXCLUDED_TOOLS = ''
  const c = loadConfig()
  assert.deepEqual(c.availableTools, ['a', 'b', 'c'])
  assert.equal(c.excludedTools, undefined)
})

test('loadConfig parses positive integers and rejects garbage', () => {
  setMinimalOpenAi()
  process.env.AGENT_MAX_ITERATIONS = '7'
  process.env.AGENT_MAX_STEPS_PER_TASK = '12'
  const c = loadConfig()
  assert.equal(c.maxIterations, 7)
  assert.equal(c.maxStepsPerTask, 12)

  process.env.AGENT_MAX_ITERATIONS = '-1'
  assert.throws(() => loadConfig(), /-1/)
})

test('loadConfig accepts a known tool selection strategy', () => {
  setMinimalOpenAi()
  process.env.AGENT_TOOL_SELECTION_STRATEGY = 'plan-narrowed'
  const c = loadConfig()
  assert.equal(c.toolSelectionStrategy, 'plan-narrowed')
})

test('loadConfig rejects an unknown tool selection strategy', () => {
  setMinimalOpenAi()
  process.env.AGENT_TOOL_SELECTION_STRATEGY = 'random'
  assert.throws(() => loadConfig(), /AGENT_TOOL_SELECTION_STRATEGY/)
})
