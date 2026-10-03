import { generateObject } from 'ai'
import { z } from 'zod'
import { stageCallOptions } from './call-options.ts'
import type { IAgentInternalContext } from './internal.ts'
import { PlanSchema, catalogModeFor, effectiveToolStrategy } from './planner.ts'
import { buildReplannerUserPrompt, composeReplannerSystem } from './prompts.ts'
import { ATTR, withSpan } from './tracing.ts'
import type { IPlan, IPlanStep, IStepResult, IUsage } from './types.ts'
import { normalizeUsage, withRetry, withTimeout } from './utils.ts'

export const DecisionSchema = z.discriminatedUnion('mode', [
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
): Promise<ReplanDecision> =>
  withSpan('agent.replan', { [ATTR.PHASE]: 'replan' }, async (span) => {
    const catalogMode = catalogModeFor(effectiveToolStrategy(ctx))
    const view = ctx.run
      ? { summary: ctx.run.traceSummary, upTo: ctx.run.traceSummaryUpTo }
      : undefined

    const { object, usage } = await withRetry(
      async () => {
        const call = stageCallOptions(
          ctx.config,
          'replanner',
          composeReplannerSystem({
            mode: catalogMode,
            catalog: ctx.toolCatalog,
            domain: ctx.config.systemPrompt,
            skills: ctx.skills,
            activeSkills: ctx.run?.activeSkills,
          }),
        )
        const r = await generateObject({
          model: ctx.plannerModel,
          schema: DecisionSchema,
          ...call,
          prompt: buildReplannerUserPrompt(input, plan, trace, nextStep, view),
          abortSignal: withTimeout(signal, ctx.config.llmTimeoutMs ?? 0),
        })
        const usage: IUsage = normalizeUsage(r.usage)
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
    span.setAttribute(ATTR.REPLAN_MODE, object.mode)
    span.setAttribute(ATTR.USAGE_TOTAL_TOKENS, usage.totalTokens)
    return object
  })
