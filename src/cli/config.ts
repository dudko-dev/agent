import type {
  IAgentConfig,
  IAgentStageOverride,
  ICompactionConfig,
  IEgressPolicy,
  ILearningConfig,
  IMcpServerConfig,
  ITokenLimits,
  IToolApprovalConfig,
  LogLevel,
  ProviderType,
  ThinkingLevel,
  ThinkingSetting,
  ToolApprovalMode,
  ToolPermission,
} from '../index.ts'
import { DirSkillStore } from '../learning.ts'

const PROVIDERS: readonly ProviderType[] = [
  'openai',
  'anthropic',
  'openai-compatible',
  'google',
  'xai',
  'azure',
  'amazon-bedrock',
  'google-vertex',
  'deepseek',
  'gateway',
  'cloudflare',
]
const REQUIRES_BASE_URL: ReadonlySet<ProviderType> = new Set<ProviderType>([
  'openai-compatible',
  'azure',
])
const LOG_LEVELS: readonly LogLevel[] = ['none', 'error', 'warn', 'info', 'debug']
const TOOL_STRATEGIES = ['all', 'plan-narrowed', 'search', 'auto'] as const
const THINKING_LEVELS: readonly ThinkingLevel[] = [
  'provider-default',
  'none',
  'minimal',
  'low',
  'medium',
  'high',
  'xhigh',
]
const APPROVAL_MODES: readonly ToolApprovalMode[] = [
  'autopilot',
  'ask-writes',
  'ask-all',
  'read-only',
]
type ToolStrategy = (typeof TOOL_STRATEGIES)[number]

export const loadConfig = (): IAgentConfig => {
  const providerType = (process.env.AGENT_PROVIDER_TYPE ?? 'openai') as ProviderType
  if (!PROVIDERS.includes(providerType)) {
    throw new Error(`AGENT_PROVIDER_TYPE must be ${PROVIDERS.join(' | ')}, got: ${providerType}`)
  }

  const logLevel = (process.env.AGENT_LOG_LEVEL ?? 'info') as LogLevel
  if (!LOG_LEVELS.includes(logLevel)) {
    throw new Error(`AGENT_LOG_LEVEL must be ${LOG_LEVELS.join(' | ')}, got: ${logLevel}`)
  }

  // baseURL is required for providers with no SDK-default endpoint
  // (openai-compatible self-hosts, azure deployments). All others accept
  // an empty/missing value and fall back to the SDK's built-in default.
  const baseURL = REQUIRES_BASE_URL.has(providerType)
    ? required('AGENT_BASE_URL')
    : process.env.AGENT_BASE_URL?.trim() || undefined

  return {
    clientName: process.env.AGENT_CLIENT_NAME ?? 'vercel-mcp-test',
    providerType,
    baseURL,
    apiKey: required('AGENT_API_KEY'),
    model: required('AGENT_MODEL'),
    providerOptions: parseProviderOptions('AGENT_PROVIDER_OPTIONS'),
    // Per-stage overrides: AGENT_PLANNER_* / AGENT_SYNTHESIZER_*. The legacy
    // AGENT_PLANNER_MODEL / AGENT_SYNTHESIZER_MODEL still feed the deprecated
    // top-level model shortcut so existing setups keep working untouched.
    planner: parseStageOverride('AGENT_PLANNER'),
    synthesizer: parseStageOverride('AGENT_SYNTHESIZER'),
    plannerModel: process.env.AGENT_PLANNER_MODEL?.trim() || undefined,
    synthesizerModel: process.env.AGENT_SYNTHESIZER_MODEL?.trim() || undefined,
    mcpServers: parseMcpServers(process.env.MCP_SERVERS),
    availableTools: parseList(process.env.AGENT_AVAILABLE_TOOLS),
    excludedTools: parseList(process.env.AGENT_EXCLUDED_TOOLS),
    maxIterations: parsePositiveInt(process.env.AGENT_MAX_ITERATIONS, 10),
    maxStepsPerTask: parsePositiveInt(process.env.AGENT_MAX_STEPS_PER_TASK, 8),
    maxRevisions: parseOptionalInt(process.env.AGENT_MAX_REVISIONS),
    maxTotalTokens: parseOptionalInt(process.env.AGENT_MAX_TOTAL_TOKENS),
    limits: parseLimits(),
    maxToolCalls: parseOptionalInt(process.env.AGENT_MAX_TOOL_CALLS),
    thinking: parseThinking(process.env.AGENT_THINKING),
    toolApproval: parseApproval(process.env.AGENT_TOOL_APPROVAL, process.env.AGENT_TOOL_RULES),
    compaction: parseCompaction(),
    egress: parseEgress(),
    learning: parseLearning(),
    llmTimeoutMs: parseOptionalInt(process.env.AGENT_LLM_TIMEOUT_MS),
    llmMaxRetries: parseOptionalInt(process.env.AGENT_LLM_MAX_RETRIES),
    toolSelectionStrategy: parseToolStrategy(process.env.AGENT_TOOL_SELECTION_STRATEGY),
    logLevel,
  }
}

// AGENT_THINKING: off | provider-default | none | minimal | low | medium |
// high | xhigh | <number> (an exact budget in tokens, level 'medium').
// 'off' disables thinking explicitly (reasoning: 'none'); unset leaves the
// provider default.
export const parseThinking = (raw: string | undefined): ThinkingSetting | undefined => {
  const v = raw?.trim().toLowerCase()
  if (!v) {
    return undefined
  }
  if (v === 'off') {
    return 'none'
  }
  if (THINKING_LEVELS.includes(v as ThinkingLevel)) {
    return v as ThinkingLevel
  }
  const n = Number(v)
  if (Number.isFinite(n) && n > 0) {
    return { level: 'medium', budgetTokens: Math.floor(n) }
  }
  throw new Error(
    `AGENT_THINKING must be off | ${THINKING_LEVELS.join(' | ')} | <budget tokens>, got: ${raw}`,
  )
}

// AGENT_MAX_INPUT_TOKENS / AGENT_MAX_OUTPUT_TOKENS / AGENT_MAX_REASONING_TOKENS.
// (AGENT_MAX_TOTAL_TOKENS keeps feeding the legacy top-level maxTotalTokens.)
const parseLimits = (): ITokenLimits | undefined => {
  const limits: ITokenLimits = {}
  const input = parseOptionalInt(process.env.AGENT_MAX_INPUT_TOKENS)
  const output = parseOptionalInt(process.env.AGENT_MAX_OUTPUT_TOKENS)
  const reasoning = parseOptionalInt(process.env.AGENT_MAX_REASONING_TOKENS)
  if (input) {
    limits.maxInputTokens = input
  }
  if (output) {
    limits.maxOutputTokens = output
  }
  if (reasoning) {
    limits.maxReasoningTokens = reasoning
  }
  return Object.keys(limits).length ? limits : undefined
}

const TOOL_PERMISSIONS: readonly ToolPermission[] = ['allow', 'ask', 'deny']

// AGENT_TOOL_RULES: a JSON object mapping tool names (exact, or with '*' globs)
// to allow | ask | deny, e.g. {"github__delete_*":"deny","docs__*":"allow"}. The
// most specific match wins (exact beats the longest glob) and it beats the
// mode, so a rule holds even under autopilot — this is the CLI's counterpart of
// the permissions block in a settings file. Validated eagerly: a typo such as
// "dney" silently leaving a destructive tool open is the failure this prevents.
export const parseToolRules = (
  raw: string | undefined,
): Record<string, ToolPermission> | undefined => {
  const v = raw?.trim()
  if (!v) {
    return undefined
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(v)
  } catch {
    throw new Error('AGENT_TOOL_RULES must be a JSON object, e.g. {"github__delete_*":"deny"}')
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('AGENT_TOOL_RULES must be a JSON object, e.g. {"github__delete_*":"deny"}')
  }
  const rules: Record<string, ToolPermission> = {}
  for (const [pattern, permission] of Object.entries(parsed)) {
    if (!pattern.trim()) {
      throw new Error('AGENT_TOOL_RULES: a rule needs a non-empty tool name or pattern')
    }
    if (!TOOL_PERMISSIONS.includes(permission as ToolPermission)) {
      throw new Error(
        `AGENT_TOOL_RULES["${pattern}"] must be ${TOOL_PERMISSIONS.join(' | ')}, got: ${JSON.stringify(permission)}`,
      )
    }
    rules[pattern] = permission as ToolPermission
  }
  return Object.keys(rules).length ? rules : undefined
}

const parseApproval = (
  rawMode: string | undefined,
  rawRules?: string,
): IToolApprovalConfig | undefined => {
  const v = rawMode?.trim()
  if (v && !APPROVAL_MODES.includes(v as ToolApprovalMode)) {
    throw new Error(`AGENT_TOOL_APPROVAL must be ${APPROVAL_MODES.join(' | ')}, got: ${v}`)
  }
  const rules = parseToolRules(rawRules)
  if (!v && !rules) {
    return undefined
  }
  return { ...(v ? { mode: v as ToolApprovalMode } : {}), ...(rules ? { rules } : {}) }
}

// AGENT_EGRESS=on lets the model read the web (the web_fetch tool); off (the default) means no
// outbound requests of its own. The rest narrows it: AGENT_EGRESS_ALLOW / AGENT_EGRESS_DENY
// (comma lists: "docs.example.com", "*.example.com", an IP or a CIDR), AGENT_EGRESS_PROTOCOLS
// (https | http), AGENT_EGRESS_ALLOW_PRIVATE=on (reach private networks - cloud metadata stays
// refused). Setting any of them while AGENT_EGRESS is off is an error, not a silent no-op.
export const parseEgress = (env: NodeJS.ProcessEnv = process.env): IEgressPolicy | undefined => {
  const raw = env.AGENT_EGRESS?.trim().toLowerCase()
  const on = raw !== undefined && ['on', 'true', '1', 'yes'].includes(raw)
  if (raw && !on && !['off', 'false', '0', 'no'].includes(raw)) {
    throw new Error(`AGENT_EGRESS must be on | off, got: ${env.AGENT_EGRESS}`)
  }
  const allow = parseList(env.AGENT_EGRESS_ALLOW)
  const deny = parseList(env.AGENT_EGRESS_DENY)
  const protocols = parseList(env.AGENT_EGRESS_PROTOCOLS)
  const priv = env.AGENT_EGRESS_ALLOW_PRIVATE?.trim().toLowerCase()
  if (!on) {
    const stray = [
      allow && 'AGENT_EGRESS_ALLOW',
      deny && 'AGENT_EGRESS_DENY',
      protocols && 'AGENT_EGRESS_PROTOCOLS',
      priv && 'AGENT_EGRESS_ALLOW_PRIVATE',
    ].filter(Boolean)
    if (stray.length) {
      throw new Error(
        `${stray.join(', ')} set but AGENT_EGRESS is off - set AGENT_EGRESS=on to use it`,
      )
    }
    return undefined
  }
  for (const p of protocols ?? []) {
    if (p !== 'https' && p !== 'http') {
      throw new Error(`AGENT_EGRESS_PROTOCOLS must list https and/or http, got: ${p}`)
    }
  }
  if (priv && !['on', 'true', '1', 'yes', 'off', 'false', '0', 'no'].includes(priv)) {
    throw new Error(
      `AGENT_EGRESS_ALLOW_PRIVATE must be on | off, got: ${env.AGENT_EGRESS_ALLOW_PRIVATE}`,
    )
  }
  return {
    ...(allow ? { allow } : {}),
    ...(deny ? { deny } : {}),
    ...(protocols ? { protocols: protocols as ('https' | 'http')[] } : {}),
    ...(priv && ['on', 'true', '1', 'yes'].includes(priv) ? { allowPrivateNetwork: true } : {}),
  }
}

// AGENT_LEARNING=on lets the agent write down what it learned (lessons become skills for the rest
// of the session - the REPL process). AGENT_LEARNING_DIR=<dir> keeps them as <dir>/<name>/SKILL.md
// across sessions. A dir without the switch is an error, not a silent no-op.
export const parseLearning = (
  env: NodeJS.ProcessEnv = process.env,
): ILearningConfig | undefined => {
  const raw = env.AGENT_LEARNING?.trim().toLowerCase()
  const on = raw !== undefined && ['on', 'true', '1', 'yes'].includes(raw)
  if (raw && !on && !['off', 'false', '0', 'no'].includes(raw)) {
    throw new Error(`AGENT_LEARNING must be on | off, got: ${env.AGENT_LEARNING}`)
  }
  const dir = env.AGENT_LEARNING_DIR?.trim()
  if (!on) {
    if (dir) {
      throw new Error(
        'AGENT_LEARNING_DIR set but AGENT_LEARNING is off - set AGENT_LEARNING=on to use it',
      )
    }
    return undefined
  }
  return dir ? { store: new DirSkillStore(dir) } : {}
}

// AGENT_COMPACTION=off disables automatic compaction (the /compact command
// still works); AGENT_CONTEXT_WINDOW_TOKENS sets the window the default
// threshold (50%) is derived from.
const parseCompaction = (): ICompactionConfig | undefined => {
  const raw = process.env.AGENT_COMPACTION?.trim().toLowerCase()
  const window = parseOptionalInt(process.env.AGENT_CONTEXT_WINDOW_TOKENS)
  const cfg: ICompactionConfig = {}
  if (raw) {
    if (['off', 'false', '0', 'no'].includes(raw)) {
      cfg.auto = false
    } else if (['on', 'auto', 'true', '1', 'yes'].includes(raw)) {
      cfg.auto = true
    } else {
      throw new Error(`AGENT_COMPACTION must be on | off, got: ${process.env.AGENT_COMPACTION}`)
    }
  }
  if (window) {
    cfg.contextWindowTokens = window
  }
  return Object.keys(cfg).length ? cfg : undefined
}

// AGENT_SKILLS_DIR: a folder of <skill>/SKILL.md (loaded by the REPL, which
// is async; loadConfig stays sync).
export const skillsDirFromEnv = (): string | undefined =>
  process.env.AGENT_SKILLS_DIR?.trim() || undefined

// Read AGENT_<prefix>_PROVIDER_TYPE / _BASE_URL / _API_KEY / _MODEL into a
// stage override block. Returns undefined if no field is set so the agent
// inherits everything from the top-level defaults.
const parseStageOverride = (prefix: string): IAgentStageOverride | undefined => {
  const provider = process.env[`${prefix}_PROVIDER_TYPE`]?.trim()
  const baseURL = process.env[`${prefix}_BASE_URL`]?.trim()
  const apiKey = process.env[`${prefix}_API_KEY`]?.trim()
  const providerOptions = parseProviderOptions(`${prefix}_PROVIDER_OPTIONS`)
  // Stage block mirrors planner/synthesizer.model. The deprecated single-
  // string AGENT_PLANNER_MODEL / AGENT_SYNTHESIZER_MODEL still flows through
  // the legacy plannerModel/synthesizerModel slot - we ignore it here so the
  // override block can stay independently undefined.
  if (!provider && !baseURL && !apiKey && !providerOptions) {
    return undefined
  }
  if (provider && !PROVIDERS.includes(provider as ProviderType)) {
    throw new Error(`${prefix}_PROVIDER_TYPE must be ${PROVIDERS.join(' | ')}, got: ${provider}`)
  }
  return {
    providerType: (provider as ProviderType) || undefined,
    baseURL: baseURL || undefined,
    apiKey: apiKey || undefined,
    providerOptions,
  }
}

// Parse a provider-options JSON env block (e.g. AGENT_PROVIDER_OPTIONS,
// AGENT_PLANNER_PROVIDER_OPTIONS). Empty / unset returns undefined so the
// agent's config-level inheritance kicks in.
const parseProviderOptions = (varName: string): Record<string, unknown> | undefined => {
  const raw = process.env[varName]?.trim()
  if (!raw) {
    return undefined
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch (err) {
    throw new Error(`${varName} must be valid JSON: ${(err as Error).message}`)
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`${varName} must be a JSON object (got ${typeof parsed})`)
  }
  return parsed as Record<string, unknown>
}

const parseToolStrategy = (raw: string | undefined): ToolStrategy | undefined => {
  const v = raw?.trim()
  if (!v) {
    return undefined
  }
  if (!TOOL_STRATEGIES.includes(v as ToolStrategy)) {
    throw new Error(
      `AGENT_TOOL_SELECTION_STRATEGY must be ${TOOL_STRATEGIES.join(' | ')}, got: ${v}`,
    )
  }
  return v as ToolStrategy
}

const parseOptionalInt = (raw: string | undefined): number | undefined => {
  if (!raw?.trim()) {
    return undefined
  }
  const n = Number(raw)
  if (!Number.isFinite(n) || n < 0) {
    throw new Error(`Expected non-negative number, got: ${raw}`)
  }
  return Math.floor(n)
}

const required = (name: string): string => {
  const v = process.env[name]?.trim()
  if (!v) {
    throw new Error(`Missing required env var: ${name}`)
  }
  return v
}

const parseList = (raw: string | undefined): string[] | undefined => {
  const t = raw?.trim()
  if (!t) {
    return undefined
  }
  return t
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
}

const parsePositiveInt = (raw: string | undefined, fallback: number): number => {
  if (!raw?.trim()) {
    return fallback
  }
  const n = Number(raw)
  if (!Number.isFinite(n) || n <= 0) {
    throw new Error(`Expected positive number, got: ${raw}`)
  }
  return Math.floor(n)
}

const parseMcpServers = (raw: string | undefined): Record<string, IMcpServerConfig> => {
  if (!raw?.trim()) {
    return {}
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch (err) {
    throw new Error(`MCP_SERVERS must be valid JSON: ${(err as Error).message}`)
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(
      'MCP_SERVERS must be a JSON object: Record<name, { url, headers? } | { command, args?, env?, cwd? }>',
    )
  }
  const result: Record<string, IMcpServerConfig> = {}
  for (const [name, value] of Object.entries(parsed as Record<string, unknown>)) {
    if (!value || typeof value !== 'object') {
      throw new Error(`MCP_SERVERS.${name} must be an object`)
    }
    const v = value as {
      url?: unknown
      headers?: unknown
      command?: unknown
      args?: unknown
      env?: unknown
      cwd?: unknown
    }
    const hasUrl = typeof v.url === 'string' && v.url.length > 0
    const hasCommand = typeof v.command === 'string' && v.command.length > 0
    if (hasUrl && hasCommand) {
      throw new Error(
        `MCP_SERVERS.${name}: specify either "url" (HTTP) or "command" (stdio), not both`,
      )
    }
    if (!hasUrl && !hasCommand) {
      throw new Error(`MCP_SERVERS.${name}: must specify "url" (HTTP) or "command" (stdio)`)
    }
    if (hasUrl) {
      const headers =
        v.headers && typeof v.headers === 'object' && !Array.isArray(v.headers)
          ? (v.headers as Record<string, string>)
          : undefined
      result[name] = { url: v.url as string, headers }
      continue
    }
    // stdio path
    if (v.args !== undefined && !Array.isArray(v.args)) {
      throw new Error(`MCP_SERVERS.${name}.args must be a string array`)
    }
    if (v.env !== undefined && (!v.env || typeof v.env !== 'object' || Array.isArray(v.env))) {
      throw new Error(`MCP_SERVERS.${name}.env must be a string-to-string map`)
    }
    if (v.cwd !== undefined && typeof v.cwd !== 'string') {
      throw new Error(`MCP_SERVERS.${name}.cwd must be a string`)
    }
    result[name] = {
      command: v.command as string,
      args: v.args as string[] | undefined,
      env: v.env as Record<string, string> | undefined,
      cwd: v.cwd as string | undefined,
    }
  }
  return result
}
