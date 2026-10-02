import type { JSONValue, SystemModelMessage } from 'ai'
import { buildInstructions, cacheProviderOptions, resolvePromptCaching } from './caching.ts'
import { resolveLimits } from './limits.ts'
import { mergeProviderOptions, resolveThinking, stageThinkingSetting } from './thinking.ts'
import type { AgentStage, IAgentConfig, ThinkingLevel } from './types.ts'

type CallProviderOptions = Record<string, Record<string, JSONValue>>

export interface IStageCallOptions {
  instructions: string | SystemModelMessage
  reasoning?: ThinkingLevel
  providerOptions?: CallProviderOptions
  maxOutputTokens?: number
}

const positive = (v: number | undefined): number | undefined =>
  typeof v === 'number' && Number.isFinite(v) && v > 0 ? Math.floor(v) : undefined

/**
 * The per-call options every stage passes to the AI SDK: the system prompt
 * as `instructions` (with a cache breakpoint when prompt caching is on), the
 * stage's thinking (portable `reasoning` + provider options), the prompt
 * cache key, and the stage's per-call output cap. Thinking provider options
 * are merged first, caching ones on top (deep, per provider key).
 */
export const stageCallOptions = (
  config: IAgentConfig,
  stage: AgentStage,
  system: string,
): IStageCallOptions => {
  const caching = resolvePromptCaching(config.promptCaching)
  const thinking = resolveThinking(stageThinkingSetting(config, stage))
  const providerOptions = mergeProviderOptions(
    thinking.providerOptions,
    cacheProviderOptions(caching, config.clientName, stage),
  ) as CallProviderOptions | undefined
  const maxOutputTokens = positive(resolveLimits(config).perCall?.[stage])
  return {
    instructions: buildInstructions(system, caching),
    ...(thinking.reasoning ? { reasoning: thinking.reasoning } : {}),
    ...(providerOptions ? { providerOptions } : {}),
    ...(maxOutputTokens ? { maxOutputTokens } : {}),
  }
}

// The output cap of a compaction summary call.
export const compactionMaxTokens = (config: IAgentConfig, summaryMaxTokens: number): number => {
  const perCall = positive(resolveLimits(config).perCall?.compaction)
  return perCall ? Math.min(perCall, summaryMaxTokens) : summaryMaxTokens
}
