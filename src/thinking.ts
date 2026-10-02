import type {
  AgentStage,
  IAgentConfig,
  IThinkingConfig,
  ThinkingLevel,
  ThinkingSetting,
} from './types.ts'

export type ProviderOptionsMap = Record<string, Record<string, unknown>>

export interface IResolvedThinking {
  // Portable AI SDK `reasoning` call option.
  reasoning?: ThinkingLevel
  // Provider-specific call options (budgets, "stream the thoughts").
  providerOptions?: ProviderOptionsMap
}

const LEVELS: ReadonlySet<string> = new Set<ThinkingLevel>([
  'provider-default',
  'none',
  'minimal',
  'low',
  'medium',
  'high',
  'xhigh',
])

export const isThinkingLevel = (v: unknown): v is ThinkingLevel =>
  typeof v === 'string' && LEVELS.has(v)

// Normalise any ThinkingSetting to a config object, or undefined for "send
// nothing" (false / undefined).
export const normalizeThinking = (
  setting: ThinkingSetting | undefined,
): IThinkingConfig | undefined => {
  if (setting === undefined || setting === false) {
    return undefined
  }
  if (setting === true) {
    return { level: 'medium' }
  }
  if (typeof setting === 'string') {
    return { level: setting }
  }
  return { ...setting, level: setting.level ?? 'medium' }
}

/**
 * Map a thinking setting to AI SDK call options. Pure.
 *
 * - false / undefined -> {} (provider default, nothing sent)
 * - 'none' -> { reasoning: 'none' } (explicit disable, no provider options)
 * - budgetTokens -> Anthropic `thinking` + Google `thinkingConfig` budgets
 * - otherwise, unless includeThoughts is false -> ask Google / OpenAI to
 *   return their thoughts (summaries) so they can be streamed.
 *
 * Provider-specific options take precedence over `reasoning` inside the SDK.
 */
export const resolveThinking = (setting: ThinkingSetting | undefined): IResolvedThinking => {
  const cfg = normalizeThinking(setting)
  if (!cfg) {
    return {}
  }
  const level: ThinkingLevel = cfg.level ?? 'medium'
  if (level === 'none') {
    return { reasoning: 'none' }
  }
  const includeThoughts = cfg.includeThoughts !== false
  const budget = cfg.budgetTokens
  if (typeof budget === 'number' && Number.isFinite(budget) && budget > 0) {
    const budgetTokens = Math.floor(budget)
    return {
      reasoning: level,
      providerOptions: {
        anthropic: { thinking: { type: 'enabled', budgetTokens } },
        google: { thinkingConfig: { thinkingBudget: budgetTokens, includeThoughts } },
      },
    }
  }
  if (includeThoughts) {
    return {
      reasoning: level,
      providerOptions: {
        google: { thinkingConfig: { includeThoughts: true } },
        openai: { reasoningSummary: 'auto' },
      },
    }
  }
  return { reasoning: level }
}

// The effective setting of one stage: a stageThinking entry (even `false`)
// wins over the top-level `thinking`.
export const stageThinkingSetting = (
  config: Pick<IAgentConfig, 'thinking' | 'stageThinking'>,
  stage: AgentStage,
): ThinkingSetting | undefined => {
  const own = config.stageThinking?.[stage]
  return own !== undefined ? own : config.thinking
}

// Whether a stage wants its thoughts streamed (reasoning-delta events).
export const stageEmitsThoughts = (
  config: Pick<IAgentConfig, 'thinking' | 'stageThinking'>,
  stage: AgentStage,
): boolean => normalizeThinking(stageThinkingSetting(config, stage))?.includeThoughts !== false

const isPlainObject = (v: unknown): v is Record<string, unknown> =>
  Boolean(v) && typeof v === 'object' && !Array.isArray(v)

const deepMerge = (a: Record<string, unknown>, b: Record<string, unknown>) => {
  const out: Record<string, unknown> = { ...a }
  for (const [k, v] of Object.entries(b)) {
    out[k] = isPlainObject(out[k]) && isPlainObject(v) ? deepMerge(out[k], v) : v
  }
  return out
}

// Deep-merge call-level provider options per provider key; later layers win.
// Returns undefined when every layer is empty, so callers can spread it
// without sending an empty object.
export const mergeProviderOptions = (
  ...layers: (ProviderOptionsMap | undefined)[]
): ProviderOptionsMap | undefined => {
  let out: ProviderOptionsMap | undefined
  for (const layer of layers) {
    if (!layer) {
      continue
    }
    for (const [provider, opts] of Object.entries(layer)) {
      if (!isPlainObject(opts)) {
        continue
      }
      out ??= {}
      out[provider] = deepMerge(out[provider] ?? {}, opts)
    }
  }
  return out
}
