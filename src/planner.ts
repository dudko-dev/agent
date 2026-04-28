import { streamObject } from 'ai'
import { z } from 'zod'
import type { IAgentInternalContext } from './internal.ts'
import {
  buildPlannerSystem,
  buildPlannerUserPrompt,
  withDomainContext,
  type CatalogMode,
} from './prompts.ts'
import { ATTR, withSpan } from './tracing.ts'
import type { IConversationTurn, IPlan, IUsage } from './types.ts'
import { withRetry, withTimeout } from './utils.ts'

export const PlanStepSchema = z.object({
  id: z.string().min(1).describe('Short stable id, e.g. "s1", "fetch-companies"'),
  description: z.string().min(1).describe('Concrete action to perform'),
  expectedOutcome: z.string().min(1).describe('What state/data should exist after this step'),
  suggestedTools: z
    .array(z.string())
    .optional()
    .describe('Tool names from the available list, if any'),
})

export const PlanSchema = z.object({
  thought: z.string().min(1).describe('One-paragraph reasoning about how to approach the request'),
  steps: z.array(PlanStepSchema).min(1).max(8),
})

export const createInitialPlan = async (
  input: string,
  history: IConversationTurn[] | undefined,
  ctx: IAgentInternalContext,
  signal?: AbortSignal,
): Promise<IPlan> =>
  withSpan('agent.plan', { [ATTR.PHASE]: 'plan' }, async (span) => {
    const validNames = new Set(ctx.toolCatalog.map((t) => t.name))
    const catalogMode: CatalogMode =
      ctx.config.toolSelectionStrategy === 'plan-narrowed' ? 'compact' : 'full'

    const { object, usage } = await withRetry(
      () => streamPlanOnce(input, history, catalogMode, ctx, signal),
      {
        maxRetries: ctx.config.llmMaxRetries ?? 2,
        signal,
        onRetry: (attempt, err) =>
          ctx.emit({ type: 'retry', phase: 'plan', attempt, error: (err as Error).message }),
      },
    )

    ctx.emit({ type: 'usage', phase: 'plan', usage })
    span.setAttribute(ATTR.USAGE_TOTAL_TOKENS, usage.totalTokens)

    return {
      thought: object.thought,
      steps: object.steps.map((s) => {
        if (!s.suggestedTools?.length) {
          return s
        }
        const filtered = s.suggestedTools.filter((n) => validNames.has(n))
        const dropped = s.suggestedTools.length - filtered.length
        if (dropped > 0) {
          ctx.emit({
            type: 'log',
            level: 'warn',
            message: `[plan] step "${s.id}" had ${dropped} unknown suggestedTools, stripped`,
          })
        }
        if (filtered.length === 0) {
          // Every suggested tool was unknown. Mark the step so narrowed-mode
          // executor falls back to the full toolset (see executor.ts) instead
          // of running with zero tools, which would always fail the step.
          ctx.emit({
            type: 'log',
            level: 'warn',
            message: `[plan] step "${s.id}" had no valid suggestedTools left; falling back to full toolset`,
          })
          return { ...s, suggestedTools: undefined, requiresTools: true }
        }
        return { ...s, suggestedTools: filtered }
      }),
    }
  })

const streamPlanOnce = async (
  input: string,
  history: IConversationTurn[] | undefined,
  catalogMode: CatalogMode,
  ctx: IAgentInternalContext,
  signal?: AbortSignal,
): Promise<{ object: z.infer<typeof PlanSchema>; usage: IUsage }> => {
  const result = streamObject({
    model: ctx.plannerModel,
    schema: PlanSchema,
    system: withDomainContext(buildPlannerSystem(catalogMode), ctx.config.systemPrompt),
    prompt: buildPlannerUserPrompt(input, ctx.toolCatalog, history, catalogMode),
    abortSignal: withTimeout(signal, ctx.config.llmTimeoutMs ?? 0),
  })

  let lastThought = ''
  let warnedRewrite = false
  // Track which step indices we've already emitted plan.step-added for, so
  // mid-stream revisions of the steps array don't re-fire the event for the
  // same slot. The canonical plan still arrives via plan.created, so a step
  // we emit here that is later overwritten is a UI hint, not a contract.
  let stepsEmitted = 0
  for await (const partial of result.partialObjectStream) {
    const t = partial?.thought
    if (typeof t === 'string' && t !== lastThought) {
      if (t.startsWith(lastThought)) {
        ctx.emit({ type: 'plan.thought-delta', delta: t.slice(lastThought.length) })
      } else if (!warnedRewrite) {
        // Some providers (notably Gemini structured-output) rewrite the
        // partial object from scratch instead of appending. Emit a single
        // log warn so the consumer knows the streamed deltas are now stale;
        // the canonical thought arrives in 'plan.created'.
        ctx.emit({
          type: 'log',
          level: 'warn',
          message: '[plan] thought was rewritten mid-stream; streamed deltas may be inconsistent',
        })
        warnedRewrite = true
      }
      lastThought = t
    }
    const partialSteps = partial?.steps
    if (Array.isArray(partialSteps) && partialSteps.length > stepsEmitted) {
      // Only emit slots whose required fields are already present. Partial
      // steps with no description yet (the LLM is still streaming) are
      // skipped this tick; they'll come through on a subsequent partial.
      while (stepsEmitted < partialSteps.length) {
        const candidate = partialSteps[stepsEmitted]
        if (
          !candidate ||
          typeof candidate.description !== 'string' ||
          !candidate.description.length
        ) {
          break
        }
        const step = {
          id:
            typeof candidate.id === 'string' && candidate.id
              ? candidate.id
              : `s${stepsEmitted + 1}`,
          description: candidate.description,
          expectedOutcome:
            typeof candidate.expectedOutcome === 'string' ? candidate.expectedOutcome : '',
          suggestedTools: Array.isArray(candidate.suggestedTools)
            ? (candidate.suggestedTools.filter((s) => typeof s === 'string') as string[])
            : undefined,
        }
        ctx.emit({ type: 'plan.step-added', step, index: stepsEmitted })
        stepsEmitted++
      }
    }
  }
  const [object, rawUsage] = await Promise.all([result.object, result.usage])
  return {
    object,
    usage: {
      inputTokens: rawUsage.inputTokens ?? 0,
      outputTokens: rawUsage.outputTokens ?? 0,
      totalTokens: rawUsage.totalTokens ?? 0,
    },
  }
}
