import { generateObject } from 'ai'
import { z } from 'zod'
import type { IAgentInternalContext } from './internal.ts'
import { PlanSchema } from './planner.ts'
import { REPLANNER_SYSTEM, buildReplannerUserPrompt } from './prompts.ts'
import type { IPlan, IPlanStep, IStepResult, IUsage } from './types.ts'
import { withRetry, withTimeout } from './utils.ts'

const DecisionSchema = z.discriminatedUnion('mode', [
  z.object({
    mode: z.literal('continue'),
    reason: z.string().min(1).describe('Why the next step is still appropriate'),
  }),
  z.object({
    mode: z.literal('finish'),
    reason: z.string().min(1).describe('Why no more steps are needed'),
  }),
  z.object({
    mode: z.literal('revise'),
    reason: z.string().min(1).describe('Why the plan must change'),
    newPlan: PlanSchema.describe('Plan covering ONLY the remaining work'),
  }),
])

export type ReplanDecision = z.infer<typeof DecisionSchema>

export const decideNextAction = async (
  input: string,
  plan: IPlan,
  trace: IStepResult[],
  nextStep: IPlanStep | null,
  ctx: IAgentInternalContext,
  signal?: AbortSignal,
): Promise<ReplanDecision> => {
  const catalogMode = ctx.config.toolSelectionStrategy === 'plan-narrowed' ? 'compact' : 'full'

  const { object, usage } = await withRetry(
    async () => {
      const r = await generateObject({
        model: ctx.plannerModel,
        schema: DecisionSchema,
        system: REPLANNER_SYSTEM,
        prompt: buildReplannerUserPrompt(
          input,
          plan,
          trace,
          nextStep,
          ctx.toolCatalog,
          catalogMode,
        ),
        abortSignal: withTimeout(signal, ctx.config.llmTimeoutMs ?? 0),
      })
      const usage: IUsage = {
        inputTokens: r.usage.inputTokens ?? 0,
        outputTokens: r.usage.outputTokens ?? 0,
        totalTokens: r.usage.totalTokens ?? 0,
      }
      return { object: r.object, usage }
    },
    {
      maxRetries: ctx.config.llmMaxRetries ?? 2,
      signal,
      onRetry: (attempt, err) =>
        ctx.emit({ type: 'retry', phase: 'replan', attempt, error: (err as Error).message }),
    },
  )

  ctx.emit({ type: 'usage', phase: 'replan', usage })
  return object
}
