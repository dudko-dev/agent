import type { SystemModelMessage } from 'ai'
import type { PromptCachingSetting } from './types.ts'
import type { ProviderOptionsMap } from './thinking.ts'

export interface IResolvedPromptCaching {
  enabled: boolean
  ttl?: '5m' | '1h'
  key?: string
}

// Default ON: a cache breakpoint on a run-stable system prompt is free on
// providers that ignore it and cuts input cost on the ones that honour it.
export const resolvePromptCaching = (
  setting: PromptCachingSetting | undefined,
): IResolvedPromptCaching => {
  if (setting === false) {
    return { enabled: false }
  }
  if (setting === undefined || setting === true) {
    return { enabled: true }
  }
  return {
    enabled: true,
    ...(setting.ttl ? { ttl: setting.ttl } : {}),
    ...(setting.key ? { key: setting.key } : {}),
  }
}

/**
 * The `instructions` call option for a system prompt. With caching on, a
 * SystemModelMessage carrying an Anthropic ephemeral cache breakpoint (other
 * providers ignore the key); otherwise the plain string.
 */
export const buildInstructions = (
  system: string,
  caching: IResolvedPromptCaching,
): string | SystemModelMessage => {
  if (!caching.enabled) {
    return system
  }
  return {
    role: 'system',
    content: system,
    providerOptions: {
      anthropic: {
        cacheControl: { type: 'ephemeral', ...(caching.ttl ? { ttl: caching.ttl } : {}) },
      },
    },
  }
}

// Call-level provider options for caching: an OpenAI prompt cache key per
// stage so requests of the same stage share a cache shard.
export const cacheProviderOptions = (
  caching: IResolvedPromptCaching,
  clientName: string,
  stage: string,
): ProviderOptionsMap | undefined =>
  caching.enabled
    ? { openai: { promptCacheKey: caching.key ?? `${clientName}:${stage}` } }
    : undefined

type WithProviderOptions = { providerOptions?: unknown }

// The message without an Anthropic cache breakpoint (other provider options kept).
const withoutBreakpoint = <M extends WithProviderOptions>(m: M): M => {
  const own = m.providerOptions as Record<string, Record<string, unknown>> | undefined
  if (!own?.anthropic || !('cacheControl' in own.anthropic)) {
    return m
  }
  const { cacheControl: _drop, ...anthropic } = own.anthropic
  const { anthropic: _old, ...rest } = own
  const providerOptions = Object.keys(anthropic).length ? { ...rest, anthropic } : rest
  const { providerOptions: _po, ...base } = m
  return (Object.keys(providerOptions).length ? { ...base, providerOptions } : base) as M
}

/**
 * The conversation with a rolling cache breakpoint on its LAST message — the
 * agent-loop pattern Claude Code uses: every tool-calling round re-sends the
 * rounds before it, and with the breakpoint on the newest message each request
 * reads all of them from the cache and writes only the new tail. Breakpoints
 * on earlier messages are removed (the SDK carries a round's messages into the
 * next one), so a request holds at most two — system + newest; Anthropic
 * rejects more than four.
 */
export const withRollingBreakpoint = <M extends WithProviderOptions>(
  messages: M[],
  caching: IResolvedPromptCaching,
): M[] => {
  if (!caching.enabled || messages.length === 0) {
    return messages
  }
  const out = messages.map((m, i) => (i < messages.length - 1 ? withoutBreakpoint(m) : m))
  const last = out[out.length - 1]
  const own = (last.providerOptions ?? {}) as Record<string, Record<string, unknown>>
  out[out.length - 1] = {
    ...last,
    providerOptions: {
      ...own,
      anthropic: {
        ...own.anthropic,
        cacheControl: { type: 'ephemeral', ...(caching.ttl ? { ttl: caching.ttl } : {}) },
      },
    },
  }
  return out
}
