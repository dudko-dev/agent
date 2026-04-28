import type { IAgentConfig, IMcpServerConfig, LogLevel, ProviderType } from '../index.ts'

const PROVIDERS: readonly ProviderType[] = ['openai', 'anthropic', 'openai-compatible', 'google']
const LOG_LEVELS: readonly LogLevel[] = ['none', 'error', 'warn', 'info', 'debug']
const TOOL_STRATEGIES = ['all', 'plan-narrowed'] as const
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

  // baseURL is required only for self-hosted OpenAI-compatible servers; for
  // providers with a known default endpoint (openai, anthropic, google) we
  // accept an empty/missing value and the SDK uses its built-in default.
  const baseURL =
    providerType === 'openai-compatible'
      ? required('AGENT_BASE_URL')
      : process.env.AGENT_BASE_URL?.trim() || undefined

  return {
    clientName: process.env.AGENT_CLIENT_NAME ?? 'vercel-mcp-test',
    providerType,
    baseURL,
    apiKey: required('AGENT_API_KEY'),
    model: required('AGENT_MODEL'),
    plannerModel: process.env.AGENT_PLANNER_MODEL?.trim() || undefined,
    synthesizerModel: process.env.AGENT_SYNTHESIZER_MODEL?.trim() || undefined,
    mcpServers: parseMcpServers(process.env.MCP_SERVERS),
    availableTools: parseList(process.env.AGENT_AVAILABLE_TOOLS),
    excludedTools: parseList(process.env.AGENT_EXCLUDED_TOOLS),
    maxIterations: parsePositiveInt(process.env.AGENT_MAX_ITERATIONS, 10),
    maxStepsPerTask: parsePositiveInt(process.env.AGENT_MAX_STEPS_PER_TASK, 8),
    maxRevisions: parseOptionalInt(process.env.AGENT_MAX_REVISIONS),
    maxTotalTokens: parseOptionalInt(process.env.AGENT_MAX_TOTAL_TOKENS),
    llmTimeoutMs: parseOptionalInt(process.env.AGENT_LLM_TIMEOUT_MS),
    llmMaxRetries: parseOptionalInt(process.env.AGENT_LLM_MAX_RETRIES),
    toolSelectionStrategy: parseToolStrategy(process.env.AGENT_TOOL_SELECTION_STRATEGY),
    logLevel,
  }
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
