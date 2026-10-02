import { streamObject } from 'ai'
import { z } from 'zod'
import { stageCallOptions } from './call-options.ts'
import type { EffectiveToolStrategy, IAgentInternalContext } from './internal.ts'
import {
  DEFAULT_PLAN_STEP_CAP,
  buildPlannerUserPrompt,
  composePlannerSystem,
  type PromptCatalogMode,
} from './prompts.ts'
import { resolveToolStrategy } from './tool-search.ts'
import { ATTR, withSpan } from './tracing.ts'
import type { IConversationTurn, IPlan, IUsage } from './types.ts'
import { normalizeUsage, withRetry, withTimeout } from './utils.ts'

export const PlanStepSchema = z.object({
  id: z.string().min(1).describe('Short stable id, e.g. "s1", "fetch-companies"'),
  description: z.string().min(1).describe('Concrete action to perform'),
  expectedOutcome: z.string().min(1).describe('What state/data should exist after this step'),
  suggestedTools: z
    .array(z.string())
    .optional()
    .describe('Tool names from the available list, if any'),
})

// NOTE: no .max() on steps — Anthropic's native structured output
// (output_config.format.schema) rejects `maxItems` on array types. The cap
// is enforced via the planner prompt ("hard cap is N") and a slice() below.
// Configurable per agent with `maxPlanSteps`.
export const PLAN_STEP_HARD_CAP = DEFAULT_PLAN_STEP_CAP

export const PlanSchema = z.object({
  thought: z.string().min(1).describe('One-paragraph reasoning about how to approach the request'),
  steps: z.array(PlanStepSchema).min(1),
  // No .max() either (same Anthropic constraint).
  skills: z
    .array(z.string())
    .optional()
    .describe('Names of skills from the SKILLS list that apply to this request'),
})

// The effective plan-step cap of an agent.
export const planStepCap = (ctx: IAgentInternalContext): number => {
  const v = ctx.config.maxPlanSteps
  return typeof v === 'number' && Number.isFinite(v) && v >= 1 ? Math.floor(v) : PLAN_STEP_HARD_CAP
}

// The run's effective tool strategy (set by the runner), or resolved from
// the config for direct callers.
export const effectiveToolStrategy = (ctx: IAgentInternalContext): EffectiveToolStrategy => {
  if (ctx.run) {
    return ctx.run.strategy
  }
  const s = resolveToolStrategy(ctx.config, ctx.toolCatalog.length)
  return s === 'search' && !ctx.findTools ? 'all' : s
}

export const catalogModeFor = (strategy: EffectiveToolStrategy): PromptCatalogMode =>
  strategy === 'plan-narrowed' ? 'compact' : strategy === 'search' ? 'search' : 'full'

// Keep only configured skill names (deduplicated); report the rest.
export const filterPlanSkills = (
  ctx: IAgentInternalContext,
  names: string[] | undefined,
): string[] | undefined => {
  if (!names?.length) {
    return undefined
  }
  const known = new Set((ctx.skills ?? []).map((s) => s.name))
  const kept = [...new Set(names.filter((n) => known.has(n)))]
  const dropped = names.filter((n) => !known.has(n))
  if (dropped.length) {
    ctx.emit({
      type: 'log',
      level: 'warn',
      message: `[plan] dropped unknown skills: ${dropped.join(', ')}`,
    })
  }
  return kept.length ? kept : undefined
}

export const createInitialPlan = async (
  input: string,
  history: IConversationTurn[] | undefined,
  ctx: IAgentInternalContext,
  signal?: AbortSignal,
): Promise<IPlan> =>
  withSpan('agent.plan', { [ATTR.PHASE]: 'plan' }, async (span) => {
    const validNames = new Set(ctx.toolCatalog.map((t) => t.name))
    const catalogMode = catalogModeFor(effectiveToolStrategy(ctx))
    const cap = planStepCap(ctx)

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

    const cappedSteps = object.steps.slice(0, cap)
    if (cappedSteps.length < object.steps.length) {
      ctx.emit({
        type: 'log',
        level: 'warn',
        message: `[plan] model returned ${object.steps.length} steps; truncated to hard cap ${cap}`,
      })
    }
    const skills = filterPlanSkills(ctx, object.skills)

    return {
      thought: object.thought,
      ...(skills ? { skills } : {}),
      steps: cappedSteps.map((s) => {
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
  catalogMode: PromptCatalogMode,
  ctx: IAgentInternalContext,
  signal?: AbortSignal,
): Promise<{ object: z.infer<typeof PlanSchema>; usage: IUsage }> => {
  const call = stageCallOptions(
    ctx.config,
    'planner',
    composePlannerSystem({
      mode: catalogMode,
      catalog: ctx.toolCatalog,
      maxSteps: planStepCap(ctx),
      domain: ctx.config.systemPrompt,
      skills: ctx.skills,
    }),
  )
  const result = streamObject({
    model: ctx.plannerModel,
    schema: PlanSchema,
    ...call,
    prompt: buildPlannerUserPrompt(input, history),
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
  return { object, usage: normalizeUsage(rawUsage) }
}
