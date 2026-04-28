import { stepCountIs, streamText, type ToolSet } from 'ai'
import type { IAgentInternalContext } from './internal.ts'
import { EXECUTOR_SYSTEM, buildExecutorUserPrompt, withDomainContext } from './prompts.ts'
import { ATTR, withSpan } from './tracing.ts'
import type { IConversationTurn, IPlan, IPlanStep, IStepResult, IUsage } from './types.ts'
import { withRetry, withTimeout } from './utils.ts'

export const buildActiveToolSet = (ctx: IAgentInternalContext, step: IPlanStep): ToolSet => {
  if (ctx.config.toolSelectionStrategy !== 'plan-narrowed') {
    return ctx.tools
  }
  const allowed = new Set(step.suggestedTools ?? [])
  if (allowed.size === 0) {
    // Recovery path: planner originally suggested tools but every name was
    // unknown (see planner.ts). Falling back to the full toolset gives the
    // executor a chance to succeed instead of stalling with zero tools.
    if (step.requiresTools) {
      return ctx.tools
    }
    return {}
  }
  const filtered: ToolSet = {}
  for (const name of allowed) {
    const tool = ctx.tools[name]
    if (tool) {
      filtered[name] = tool
    }
  }
  return filtered
}

const BLOCKER_SENTINEL = '[BLOCKER]'

// Splits the executor's raw reply into a clean summary + a structural blocked
// flag. The sentinel is removed from the surfaced summary so it does not
// pollute downstream prompts (planner/replanner/synthesizer); the boolean
// drives runner.ts's decision to invoke the replanner. Language-agnostic by
// construction - works regardless of which language the executor wrote in.
export const splitBlockerSentinel = (raw: string): { summary: string; blocked: boolean } => {
  if (!raw.includes(BLOCKER_SENTINEL)) {
    return { summary: raw, blocked: false }
  }
  // Strip every occurrence: the executor occasionally emits the sentinel
  // twice (e.g. once mid-narrative and once at the end as required) and
  // leaving stray copies in the summary leaks into downstream prompts.
  const cleaned = raw.split(BLOCKER_SENTINEL).join('').trim()
  return { summary: cleaned, blocked: true }
}

const SUMMARY_MAX_CHARS = 4000

const truncateForTrace = (s: string): string =>
  s.length > SUMMARY_MAX_CHARS
    ? `${s.slice(0, SUMMARY_MAX_CHARS)}... [truncated, ${s.length - SUMMARY_MAX_CHARS} chars]`
    : s

interface RunOnceOutcome {
  summary: string
  toolCalls: IStepResult['toolCalls']
  usage: IUsage
  blocked: boolean
}

export const executeStep = async (
  input: string,
  plan: IPlan,
  step: IPlanStep,
  trace: IStepResult[],
  history: IConversationTurn[] | undefined,
  ctx: IAgentInternalContext,
  signal?: AbortSignal,
): Promise<IStepResult> =>
  withSpan(
    'agent.execute_step',
    {
      [ATTR.PHASE]: 'execute',
      [ATTR.STEP_ID]: step.id,
    },
    async (span) => {
      const startedAt = Date.now()
      const outcome = await withRetry(
        () => runOnce(input, plan, step, trace, history, ctx, signal),
        {
          maxRetries: ctx.config.llmMaxRetries ?? 2,
          signal,
          onRetry: (attempt, err) =>
            ctx.emit({ type: 'retry', phase: 'execute', attempt, error: (err as Error).message }),
        },
      )
      // Emit usage exactly once per executeStep, with the usage of the *successful*
      // attempt. Doing this inside withRetry would over-count when retries fire.
      ctx.emit({ type: 'usage', phase: 'execute', usage: outcome.usage })
      span.setAttribute(ATTR.USAGE_TOTAL_TOKENS, outcome.usage.totalTokens)
      span.setAttribute(ATTR.STEP_BLOCKED, outcome.blocked)
      span.setAttribute(ATTR.TOOL_COUNT, outcome.toolCalls.length)
      return {
        step,
        summary: outcome.summary,
        toolCalls: outcome.toolCalls,
        durationMs: Date.now() - startedAt,
        blocked: outcome.blocked,
      }
    },
  )

const runOnce = async (
  input: string,
  plan: IPlan,
  step: IPlanStep,
  trace: IStepResult[],
  history: IConversationTurn[] | undefined,
  ctx: IAgentInternalContext,
  signal?: AbortSignal,
): Promise<RunOnceOutcome> => {
  const toolCalls: IStepResult['toolCalls'] = []
  const toolInputs = new Map<string, { name: string; input: unknown }>()

  const activeTools = buildActiveToolSet(ctx, step)
  const narrowed = ctx.config.toolSelectionStrategy === 'plan-narrowed'

  const sanitizeForEvent = async (toolName: string, raw: unknown): Promise<unknown> => {
    const fn = ctx.config.inputSanitizer
    if (!fn) {
      return raw
    }
    try {
      return await fn(toolName, raw)
    } catch (err) {
      // Mirror the mcp.ts policy: a buggy sanitizer must not leak the raw
      // input through the event channel. We log once and keep the run going
      // with a placeholder; the executor will get a deterministic error from
      // the MCP wrapper (which also runs the sanitizer and bails to the
      // same placeholder).
      ctx.emit({
        type: 'log',
        level: 'warn',
        message: `[executor] inputSanitizer threw for ${toolName} - ${(err as Error).message}; event input redacted`,
      })
      return '[input redacted: sanitizer failed]'
    }
  }

  const result = streamText({
    model: ctx.executorModel,
    tools: activeTools,
    // Defence-in-depth: explicitly tell the SDK which tools are callable in
    // this step. Only worth it in narrowed mode; in 'all' mode it's just a
    // copy of every key, equivalent to omitting the field.
    ...(narrowed ? { activeTools: Object.keys(activeTools) } : {}),
    stopWhen: stepCountIs(ctx.config.maxStepsPerTask),
    system: withDomainContext(EXECUTOR_SYSTEM, ctx.config.systemPrompt),
    prompt: buildExecutorUserPrompt(input, plan, step, trace, history),
    abortSignal: withTimeout(signal, ctx.config.llmTimeoutMs ?? 0),
  })

  for await (const part of result.fullStream) {
    switch (part.type) {
      case 'text-delta':
        if (part.text) {
          ctx.emit({ type: 'step.text-delta', step, delta: part.text })
        }
        break
      case 'tool-call': {
        const sanitizedInput = await sanitizeForEvent(part.toolName, part.input)
        toolInputs.set(part.toolCallId, { name: part.toolName, input: sanitizedInput })
        ctx.emit({ type: 'step.tool-call', step, name: part.toolName, input: sanitizedInput })
        break
      }
      case 'tool-result': {
        const known = toolInputs.get(part.toolCallId)
        // Fallback path is defensive (tool-result before tool-call should
        // not happen). Sanitize the raw fallback input so an out-of-order
        // event still doesn't leak secrets.
        const recordedInput = known?.input ?? (await sanitizeForEvent(part.toolName, part.input))
        toolCalls.push({
          name: part.toolName,
          input: recordedInput,
          output: part.output,
          ok: true,
        })
        ctx.emit({
          type: 'step.tool-result',
          step,
          name: part.toolName,
          output: part.output,
          ok: true,
        })
        toolInputs.delete(part.toolCallId)
        break
      }
      case 'tool-error': {
        const known = toolInputs.get(part.toolCallId)
        const recordedInput = known?.input ?? (await sanitizeForEvent(part.toolName, part.input))
        toolCalls.push({
          name: part.toolName,
          input: recordedInput,
          output: part.error,
          ok: false,
        })
        ctx.emit({
          type: 'step.tool-result',
          step,
          name: part.toolName,
          output: part.error,
          ok: false,
        })
        toolInputs.delete(part.toolCallId)
        break
      }
      case 'error': {
        const error = part.error
        throw error instanceof Error ? error : new Error(String(error))
      }
    }
  }

  const [text, usage] = await Promise.all([result.text, result.usage])
  const { summary: cleaned, blocked } = splitBlockerSentinel(text.trim())
  const summary =
    cleaned.length > 0
      ? truncateForTrace(cleaned)
      : toolCalls.length > 0
        ? `Executed ${toolCalls.length} tool call(s) without producing a final message; consider raising maxStepsPerTask.`
        : 'Step produced no output.'

  return {
    summary,
    toolCalls,
    blocked,
    usage: {
      inputTokens: usage.inputTokens ?? 0,
      outputTokens: usage.outputTokens ?? 0,
      totalTokens: usage.totalTokens ?? 0,
    },
  }
}
