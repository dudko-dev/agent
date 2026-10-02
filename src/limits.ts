import type { StopCondition, ToolSet } from 'ai'
import type { IAgentConfig, ILimitBreach, ITokenLimits, IUsage, TokenLimitKind } from './types.ts'
import { addUsage, emptyUsage, normalizeUsage, type ISdkUsageLike } from './utils.ts'

// The effective limits of a run: `limits` with the legacy top-level
// maxTotalTokens folded in (limits.maxTotalTokens wins when both are set).
export const resolveLimits = (
  config: Pick<IAgentConfig, 'limits' | 'maxTotalTokens'>,
): ITokenLimits => {
  const maxTotalTokens = config.limits?.maxTotalTokens ?? config.maxTotalTokens
  return {
    ...config.limits,
    ...(maxTotalTokens !== undefined ? { maxTotalTokens } : {}),
  }
}

const isCap = (cap: number | undefined): cap is number =>
  typeof cap === 'number' && Number.isFinite(cap) && cap > 0

export const hasTokenLimits = (limits: ITokenLimits | undefined): boolean =>
  Boolean(
    limits &&
    (isCap(limits.maxInputTokens) ||
      isCap(limits.maxOutputTokens) ||
      isCap(limits.maxReasoningTokens) ||
      isCap(limits.maxTotalTokens)),
  )

/**
 * The first cumulative cap `usage` has reached (>=), or undefined. Pure.
 * Checked in order input, output, reasoning, total; a cap of 0 / undefined
 * is "no cap".
 */
export const checkLimits = (
  usage: IUsage,
  limits: ITokenLimits | undefined,
): ILimitBreach | undefined => {
  if (!limits) {
    return undefined
  }
  const checks: [TokenLimitKind, number, number | undefined][] = [
    ['input', usage.inputTokens, limits.maxInputTokens],
    ['output', usage.outputTokens, limits.maxOutputTokens],
    ['reasoning', usage.reasoningTokens ?? 0, limits.maxReasoningTokens],
    ['total', usage.totalTokens, limits.maxTotalTokens],
  ]
  for (const [kind, tokens, cap] of checks) {
    if (isCap(cap) && tokens >= cap) {
      return { kind, tokens, cap }
    }
  }
  return undefined
}

// Sum the usage of the steps of an in-flight streamText call.
export const sumStepUsage = (steps: { usage?: ISdkUsageLike }[]): IUsage =>
  steps.reduce<IUsage>((acc, s) => addUsage(acc, normalizeUsage(s.usage)), emptyUsage())

/**
 * A stopWhen condition for the executor's tool loop: stops at the next step
 * boundary once the run's usage so far plus this call's steps cross a cap,
 * so a runaway tool loop cannot burn through the budget inside one step.
 * `runUsage` is read live (subagent usage lands in it mid-step).
 */
export const limitsStopCondition =
  (
    runUsage: () => IUsage,
    limits: ITokenLimits,
    onStop?: (breach: ILimitBreach) => void,
  ): StopCondition<ToolSet> =>
  ({ steps }) => {
    const breach = checkLimits(addUsage(runUsage(), sumStepUsage(steps)), limits)
    if (breach) {
      onStop?.(breach)
      return true
    }
    return false
  }
