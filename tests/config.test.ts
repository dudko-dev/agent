import assert from 'node:assert/strict'
import test, { beforeEach } from 'node:test'
import { loadConfig, parseThinking, parseToolRules, skillsDirFromEnv } from '../src/cli/config.ts'
import { decideToolPermission, type IEgressPolicy } from '../src/index.ts'

const CONFIG_KEYS = [
  'AGENT_PROVIDER_TYPE',
  'AGENT_API_KEY',
  'AGENT_MODEL',
  'AGENT_BASE_URL',
  'AGENT_PLANNER_MODEL',
  'AGENT_SYNTHESIZER_MODEL',
  'AGENT_PLANNER_PROVIDER_TYPE',
  'AGENT_PLANNER_BASE_URL',
  'AGENT_PLANNER_API_KEY',
  'AGENT_SYNTHESIZER_PROVIDER_TYPE',
  'AGENT_SYNTHESIZER_BASE_URL',
  'AGENT_SYNTHESIZER_API_KEY',
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
  'AGENT_PROVIDER_OPTIONS',
  'AGENT_PLANNER_PROVIDER_OPTIONS',
  'AGENT_SYNTHESIZER_PROVIDER_OPTIONS',
  'AGENT_THINKING',
  'AGENT_MAX_INPUT_TOKENS',
  'AGENT_MAX_OUTPUT_TOKENS',
  'AGENT_MAX_REASONING_TOKENS',
  'AGENT_MAX_TOOL_CALLS',
  'AGENT_TOOL_APPROVAL',
  'AGENT_TOOL_RULES',
  'AGENT_SKILLS_DIR',
  'AGENT_CONTEXT_WINDOW_TOKENS',
  'AGENT_COMPACTION',
  'AGENT_EGRESS',
  'AGENT_EGRESS_ALLOW',
  'AGENT_EGRESS_DENY',
  'AGENT_EGRESS_PROTOCOLS',
  'AGENT_EGRESS_ALLOW_PRIVATE',
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

test('loadConfig leaves planner / synthesizer override blocks undefined when no env vars are set', () => {
  setMinimalOpenAi()
  const c = loadConfig()
  assert.equal(c.planner, undefined)
  assert.equal(c.synthesizer, undefined)
})

test('loadConfig builds a planner override block from AGENT_PLANNER_* env vars', () => {
  setMinimalOpenAi()
  process.env.AGENT_PLANNER_PROVIDER_TYPE = 'anthropic'
  process.env.AGENT_PLANNER_API_KEY = 'sk-anthro'
  const c = loadConfig()
  assert.deepEqual(c.planner, {
    providerType: 'anthropic',
    baseURL: undefined,
    apiKey: 'sk-anthro',
    providerOptions: undefined,
  })
  assert.equal(c.synthesizer, undefined)
})

test('loadConfig rejects an unknown AGENT_PLANNER_PROVIDER_TYPE', () => {
  setMinimalOpenAi()
  process.env.AGENT_PLANNER_PROVIDER_TYPE = 'mystery'
  assert.throws(() => loadConfig(), /AGENT_PLANNER_PROVIDER_TYPE/)
})

test('loadConfig parses AGENT_PROVIDER_OPTIONS as JSON object', () => {
  setMinimalOpenAi()
  process.env.AGENT_PROVIDER_OPTIONS = '{"region":"us-east-1","timeout":5000}'
  const c = loadConfig()
  assert.deepEqual(c.providerOptions, { region: 'us-east-1', timeout: 5000 })
})

test('loadConfig rejects malformed AGENT_PROVIDER_OPTIONS JSON', () => {
  setMinimalOpenAi()
  process.env.AGENT_PROVIDER_OPTIONS = '{not json}'
  assert.throws(() => loadConfig(), /AGENT_PROVIDER_OPTIONS must be valid JSON/)
})

test('loadConfig rejects AGENT_PROVIDER_OPTIONS that is not a plain object', () => {
  setMinimalOpenAi()
  process.env.AGENT_PROVIDER_OPTIONS = '["a","b"]'
  assert.throws(() => loadConfig(), /AGENT_PROVIDER_OPTIONS must be a JSON object/)
})

test('loadConfig threads AGENT_PLANNER_PROVIDER_OPTIONS into the planner override', () => {
  setMinimalOpenAi()
  process.env.AGENT_PLANNER_PROVIDER_OPTIONS = '{"accountId":"acc-from-env"}'
  const c = loadConfig()
  assert.deepEqual(c.planner, {
    providerType: undefined,
    baseURL: undefined,
    apiKey: undefined,
    providerOptions: { accountId: 'acc-from-env' },
  })
})

test('loadConfig leaves every new knob undefined when its env var is unset', () => {
  setMinimalOpenAi()
  const c = loadConfig()
  assert.equal(c.thinking, undefined)
  assert.equal(c.limits, undefined)
  assert.equal(c.maxToolCalls, undefined)
  assert.equal(c.toolApproval, undefined)
  assert.equal(c.compaction, undefined)
  assert.equal(c.toolSelectionStrategy, undefined)
  assert.equal(skillsDirFromEnv(), undefined)
})

test('AGENT_THINKING: levels, off, and a numeric budget', () => {
  assert.equal(parseThinking(undefined), undefined)
  assert.equal(parseThinking('HIGH'), 'high')
  assert.equal(parseThinking('off'), 'none')
  assert.equal(parseThinking('minimal'), 'minimal')
  assert.deepEqual(parseThinking('4096'), { level: 'medium', budgetTokens: 4096 })
  assert.throws(() => parseThinking('turbo'), /AGENT_THINKING/)
  setMinimalOpenAi()
  process.env.AGENT_THINKING = 'xhigh'
  assert.equal(loadConfig().thinking, 'xhigh')
})

test('loadConfig parses token limits, the tool-call cap and the approval mode', () => {
  setMinimalOpenAi()
  process.env.AGENT_MAX_INPUT_TOKENS = '1000'
  process.env.AGENT_MAX_OUTPUT_TOKENS = '200'
  process.env.AGENT_MAX_REASONING_TOKENS = '50'
  process.env.AGENT_MAX_TOTAL_TOKENS = '1500'
  process.env.AGENT_MAX_TOOL_CALLS = '12'
  process.env.AGENT_TOOL_APPROVAL = 'ask-writes'
  const c = loadConfig()
  assert.deepEqual(c.limits, { maxInputTokens: 1000, maxOutputTokens: 200, maxReasoningTokens: 50 })
  assert.equal(c.maxTotalTokens, 1500, 'the legacy total cap keeps its slot')
  assert.equal(c.maxToolCalls, 12)
  assert.deepEqual(c.toolApproval, { mode: 'ask-writes' })
  process.env.AGENT_TOOL_APPROVAL = 'yolo'
  assert.throws(() => loadConfig(), /AGENT_TOOL_APPROVAL/)
})

test('loadConfig parses compaction and the new tool strategies; AGENT_SKILLS_DIR is read raw', () => {
  setMinimalOpenAi()
  process.env.AGENT_COMPACTION = 'off'
  process.env.AGENT_CONTEXT_WINDOW_TOKENS = '32000'
  process.env.AGENT_TOOL_SELECTION_STRATEGY = 'search'
  process.env.AGENT_SKILLS_DIR = ' ./skills '
  const c = loadConfig()
  assert.deepEqual(c.compaction, { auto: false, contextWindowTokens: 32000 })
  assert.equal(c.toolSelectionStrategy, 'search')
  assert.equal(skillsDirFromEnv(), './skills')
  process.env.AGENT_TOOL_SELECTION_STRATEGY = 'auto'
  assert.equal(loadConfig().toolSelectionStrategy, 'auto')
  process.env.AGENT_COMPACTION = 'sometimes'
  assert.throws(() => loadConfig(), /AGENT_COMPACTION/)
})

// ── AGENT_TOOL_RULES: the CLI's counterpart of a settings file's permissions ──

const RULES = { 'github__delete_*': 'deny', 'docs__*': 'allow', docs__write: 'ask' }

test('AGENT_TOOL_RULES: rules reach toolApproval, with or without a mode', () => {
  setMinimalOpenAi()
  process.env.AGENT_TOOL_RULES = JSON.stringify(RULES)
  assert.deepEqual(
    loadConfig().toolApproval,
    { rules: RULES },
    'no mode set: the default applies and the rules still hold',
  )
  process.env.AGENT_TOOL_APPROVAL = 'read-only'
  assert.deepEqual(loadConfig().toolApproval, { mode: 'read-only', rules: RULES })
})

test('AGENT_TOOL_RULES: a parsed rule really decides a call — a deny holds even under autopilot', () => {
  setMinimalOpenAi()
  process.env.AGENT_TOOL_RULES = JSON.stringify(RULES)
  const rules = loadConfig().toolApproval?.rules
  const decide = (name: string, mode: 'autopilot' | 'read-only' = 'autopilot') =>
    decideToolPermission({ name, readOnly: false, mode, rules })
  assert.equal(decide('github__delete_repo').permission, 'deny', 'a glob deny beats autopilot')
  assert.equal(decide('docs__read', 'read-only').permission, 'allow', 'an allow beats read-only')
  assert.equal(decide('docs__write').permission, 'ask', 'the exact rule beats the docs__* glob')
  assert.equal(decide('unrelated__tool').permission, 'allow', 'no rule: the mode decides')
})

test('AGENT_TOOL_RULES: unset or blank leaves toolApproval untouched', () => {
  setMinimalOpenAi()
  assert.equal(loadConfig().toolApproval, undefined)
  process.env.AGENT_TOOL_RULES = '   '
  assert.equal(loadConfig().toolApproval, undefined)
  process.env.AGENT_TOOL_RULES = '{}'
  assert.equal(loadConfig().toolApproval, undefined, 'an empty object is no rules')
  process.env.AGENT_TOOL_APPROVAL = 'ask-all'
  assert.deepEqual(loadConfig().toolApproval, { mode: 'ask-all' }, 'the mode alone is unchanged')
})

test('AGENT_TOOL_RULES: refuses what it cannot trust, loudly and at startup', () => {
  setMinimalOpenAi()
  const bad: [string, RegExp][] = [
    ['{not json', /JSON object/],
    ['["deny"]', /JSON object/],
    ['"deny"', /JSON object/],
    ['42', /JSON object/],
    // The case this guards: a typo must not leave a destructive tool open.
    ['{"github__delete_*":"dney"}', /must be allow \| ask \| deny/],
    ['{"github__delete_*":true}', /must be allow \| ask \| deny/],
    ['{" ":"deny"}', /non-empty/],
  ]
  for (const [raw, expected] of bad) {
    process.env.AGENT_TOOL_RULES = raw
    assert.throws(() => loadConfig(), expected, `rejects ${raw}`)
    assert.throws(() => parseToolRules(raw), /AGENT_TOOL_RULES/)
  }
})

// ── AGENT_EGRESS: what the model may fetch ────────────────────────────────────

test('AGENT_EGRESS: off by default - the agent has no way to reach the network of its own', () => {
  setMinimalOpenAi()
  assert.equal(loadConfig().egress, undefined)
  process.env.AGENT_EGRESS = 'off'
  assert.equal(loadConfig().egress, undefined)
})

test('AGENT_EGRESS: on enables it; the lists, protocols and private networks narrow or widen it', () => {
  setMinimalOpenAi()
  process.env.AGENT_EGRESS = 'on'
  assert.deepEqual(loadConfig().egress, {}, 'on with nothing else: any public host over https')

  process.env.AGENT_EGRESS_ALLOW = 'docs.example.com, *.github.com'
  process.env.AGENT_EGRESS_DENY = '10.0.0.0/8,internal.example.com'
  process.env.AGENT_EGRESS_PROTOCOLS = 'https,http'
  process.env.AGENT_EGRESS_ALLOW_PRIVATE = 'on'
  assert.deepEqual(loadConfig().egress, {
    allow: ['docs.example.com', '*.github.com'],
    deny: ['10.0.0.0/8', 'internal.example.com'],
    protocols: ['https', 'http'],
    allowPrivateNetwork: true,
  })
  process.env.AGENT_EGRESS_ALLOW_PRIVATE = 'off'
  assert.equal((loadConfig().egress as IEgressPolicy).allowPrivateNetwork, undefined)
})

test('AGENT_EGRESS: a setting without the switch, or a typo, is an error - never a silent no-op', () => {
  setMinimalOpenAi()
  for (const key of [
    'AGENT_EGRESS_ALLOW',
    'AGENT_EGRESS_DENY',
    'AGENT_EGRESS_PROTOCOLS',
    'AGENT_EGRESS_ALLOW_PRIVATE',
  ]) {
    process.env[key] = key === 'AGENT_EGRESS_PROTOCOLS' ? 'https' : 'on'
    assert.throws(() => loadConfig(), new RegExp(`${key} set but AGENT_EGRESS is off`), key)
    delete process.env[key]
  }
  process.env.AGENT_EGRESS = 'maybe'
  assert.throws(() => loadConfig(), /AGENT_EGRESS must be on \| off/)
  process.env.AGENT_EGRESS = 'on'
  process.env.AGENT_EGRESS_PROTOCOLS = 'ftp'
  assert.throws(() => loadConfig(), /AGENT_EGRESS_PROTOCOLS must list https and\/or http/)
  delete process.env.AGENT_EGRESS_PROTOCOLS
  process.env.AGENT_EGRESS_ALLOW_PRIVATE = 'sure'
  assert.throws(() => loadConfig(), /AGENT_EGRESS_ALLOW_PRIVATE must be on \| off/)
})
