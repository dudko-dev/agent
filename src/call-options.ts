import { NoObjectGeneratedError, type JSONValue, type SystemModelMessage } from 'ai'
import { buildInstructions, cacheProviderOptions, resolvePromptCaching } from './caching.ts'
import { resolveCompaction } from './compaction.ts'
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

// What one LLM call of a stage may write when the host set no `limits.perCall` for it: a share of
// the context window between a floor and a ceiling. A fixed number is wrong at both ends - a
// 400-token answer cuts a normal report short, and 8000 tokens does not fit next to the prompt in
// a 4k local model - so the cap follows the window. At the default 128k window: planner 2000,
// executor 8000, replanner 1000, synthesizer 4000. The executor's share is the widest because a
// tool call's arguments (a file it writes) count as output; the floors keep a plan or a decision,
// which are JSON that is useless cut short, from being squeezed in a small window.
export const OUTPUT_CAP_SHARES: Record<
  AgentStage,
  { num: number; den: number; min: number; max: number }
> = {
  planner: { num: 1, den: 64, min: 512, max: 4_000 },
  executor: { num: 1, den: 16, min: 2_048, max: 32_000 },
  replanner: { num: 1, den: 128, min: 256, max: 2_000 },
  synthesizer: { num: 1, den: 32, min: 1_024, max: 16_000 },
}

export interface IOutputCap {
  // The cap in force; undefined = none (the provider's own maximum applies).
  tokens?: number
  // true when it came from the window, false when the host set it (or turned it off with 0).
  derived: boolean
}

/**
 * The output cap of one call of `stage`. What the host set (`limits.perCall`) wins, and `0` is an
 * explicit "no cap". Otherwise a share of the context window - except for a stage that thinks:
 * on OpenAI and Gemini the reasoning counts against the cap, so a default sized for the answer
 * alone would leave a thinking model with no room to write it (Anthropic adds the thinking
 * budget on top, but that is the provider's rule, not a portable one). A stage that thinks keeps
 * the provider's own limit unless the host sets one.
 */
export const stageOutputCap = (config: IAgentConfig, stage: AgentStage): IOutputCap => {
  const set = resolveLimits(config).perCall?.[stage]
  if (typeof set === 'number' && Number.isFinite(set)) {
    const tokens = positive(set)
    return { ...(tokens ? { tokens } : {}), derived: false }
  }
  const thinking = resolveThinking(stageThinkingSetting(config, stage))
  if (thinking.reasoning && thinking.reasoning !== 'none') {
    return { derived: false }
  }
  const window = resolveCompaction(config.compaction).contextWindowTokens
  const share = OUTPUT_CAP_SHARES[stage]
  const tokens = Math.min(
    Math.max(share.min, Math.min(share.max, Math.floor((window * share.num) / share.den))),
    Math.floor(window / 2),
  )
  return { tokens, derived: true }
}

// The notice for a call the output cap cut off ('length'), else undefined. A truncated answer is
// silent otherwise - the model just stops - and a default cap makes that a thing a host can hit
// without ever having set a limit.
export const outputCapNotice = (
  config: IAgentConfig,
  stage: AgentStage,
  finishReason: string | undefined,
): string | undefined => {
  if (finishReason !== 'length') {
    return undefined
  }
  const cap = stageOutputCap(config, stage)
  if (!cap.tokens) {
    return undefined
  }
  return cap.derived
    ? `[${stage}] the model's output was cut off at ${cap.tokens} tokens, the default cap for this stage (a share of the ${resolveCompaction(config.compaction).contextWindowTokens}-token window); raise limits.perCall.${stage}, or set it to 0 for no cap`
    : `[${stage}] the model's output was cut off at limits.perCall.${stage} (${cap.tokens} tokens); raise it`
}

// A structured stage (planner, replanner) whose JSON was cut by the cap fails with a parse error
// that says nothing about why: add the reason to the message and hand the same error back (same
// class, so the retry logic treats it as before).
export const withCapHint = (err: unknown, config: IAgentConfig, stage: AgentStage): unknown => {
  if (NoObjectGeneratedError.isInstance(err)) {
    const notice = outputCapNotice(config, stage, err.finishReason)
    if (notice) {
      err.message = `${err.message} - ${notice}`
    }
  }
  return err
}

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
  const maxOutputTokens = stageOutputCap(config, stage).tokens
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
