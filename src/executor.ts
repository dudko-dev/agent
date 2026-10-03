import { stepCountIs, streamText, type ModelMessage, type StopCondition, type ToolSet } from 'ai'
import { resolvePromptCaching, withRollingBreakpoint } from './caching.ts'
import { resolveCompaction } from './compaction.ts'
import { createToolResultClearer } from './context-editing.ts'
import { stageCallOptions } from './call-options.ts'
import type { IAgentInternalContext } from './internal.ts'
import { hasTokenLimits, limitsStopCondition, resolveLimits } from './limits.ts'
import { effectiveToolStrategy } from './planner.ts'
import { buildExecutorUserPrompt, composeExecutorSystem } from './prompts.ts'
import { stageEmitsThoughts } from './thinking.ts'
import { MAX_CARRIED_DISCOVERED_TOOLS } from './tool-search.ts'
import { ATTR, withSpan } from './tracing.ts'
import type { IConversationTurn, IPlan, IPlanStep, IStepResult, IUsage } from './types.ts'
import { emptyUsage, normalizeUsage, withRetry, withTimeout } from './utils.ts'

// The host + MCP tools a step may use under 'all' / 'plan-narrowed' (the
// 'search' strategy builds its active set per LLM step instead; built-in
// tools are added on top by the executor).
export const buildActiveToolSet = (ctx: IAgentInternalContext, step: IPlanStep): ToolSet => {
  if (effectiveToolStrategy(ctx) !== 'plan-narrowed') {
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

// Tools for one executor call: what the strategy exposes + the built-ins.
// In 'search' mode the full catalogue is passed and `prepareStep` narrows
// each LLM step to the active set (find_tools grows it mid-call).
export const buildExecutorTools = (
  ctx: IAgentInternalContext,
  step: IPlanStep,
): { tools: ToolSet; activeTools?: string[]; active?: Set<string> } => {
  const strategy = effectiveToolStrategy(ctx)
  const builtins = ctx.builtinTools ?? {}
  if (strategy === 'search') {
    const tools: ToolSet = { ...ctx.tools, ...builtins, ...(ctx.findTools ?? {}) }
    const active = new Set<string>([...Object.keys(builtins), ...Object.keys(ctx.findTools ?? {})])
    for (const name of step.suggestedTools ?? []) {
      if (ctx.tools[name]) {
        active.add(name)
      }
    }
    for (const name of (ctx.run?.discovered ?? []).slice(-MAX_CARRIED_DISCOVERED_TOOLS)) {
      if (ctx.tools[name]) {
        active.add(name)
      }
    }
    return { tools, active }
  }
  const base = buildActiveToolSet(ctx, step)
  const tools: ToolSet = Object.keys(builtins).length ? { ...base, ...builtins } : base
  // Defence-in-depth: explicitly tell the SDK which tools are callable in
  // this step. Only worth it in narrowed mode; in 'all' mode it's just a
  // copy of every key, equivalent to omitting the field.
  return strategy === 'plan-narrowed' ? { tools, activeTools: Object.keys(tools) } : { tools }
}

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

  const { tools, activeTools, active } = buildExecutorTools(ctx, step)
  const run = ctx.run
  if (run) {
    run.stepActive = active
  }

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

  // Stop conditions: the per-step LLM-step cap, plus the run-level token /
  // tool-call budgets so a runaway tool loop stops at the next step boundary
  // instead of at the end of the step.
  let stoppedBy: 'tokens' | 'tool-calls' | undefined
  const stopWhen: StopCondition<ToolSet>[] = [stepCountIs(ctx.config.maxStepsPerTask)]
  const limits = resolveLimits(ctx.config)
  if (run && hasTokenLimits(limits)) {
    stopWhen.push(
      limitsStopCondition(
        () => run.usage,
        limits,
        () => {
          stoppedBy = 'tokens'
        },
      ),
    )
  }
  const maxToolCalls = ctx.config.maxToolCalls
  if (run && typeof maxToolCalls === 'number' && maxToolCalls > 0) {
    stopWhen.push(() => {
      if (run.toolCalls >= maxToolCalls) {
        stoppedBy ??= 'tool-calls'
        return true
      }
      return false
    })
  }

  const call = stageCallOptions(
    ctx.config,
    'executor',
    composeExecutorSystem({
      domain: ctx.config.systemPrompt,
      skills: ctx.skills,
      activeSkills: run?.activeSkills,
      searchMode: Boolean(active),
      toolCount: ctx.toolCatalog.length,
    }),
  )
  const emitThoughts = stageEmitsThoughts(ctx.config, 'executor')
  const view = run ? { summary: run.traceSummary, upTo: run.traceSummaryUpTo } : undefined

  // Before every round: re-read the search-mode active set (find_tools grows
  // it), clear stale tool results past the threshold, and roll the cache
  // breakpoint to the newest message.
  const caching = resolvePromptCaching(ctx.config.promptCaching)
  const compaction = resolveCompaction(ctx.config.compaction)
  const clear =
    compaction.clearToolResultsAfterTokens > 0
      ? createToolResultClearer(
          {
            triggerTokens: compaction.clearToolResultsAfterTokens,
            keep: compaction.keepToolResults,
          },
          (info) => {
            ctx.emit({
              type: 'log',
              level: 'info',
              message: `[executor] cleared ${info.cleared} stale tool result(s) from the step's context`,
            })
            ctx.emit({
              type: 'context.compacted',
              scope: 'tool-results',
              beforeTokens: info.beforeTokens,
              afterTokens: info.afterTokens,
            })
          },
        )
      : undefined
  const editMessages = caching.enabled || Boolean(clear)

  const result = streamText({
    model: ctx.executorModel,
    tools,
    ...(activeTools ? { activeTools } : {}),
    ...(active || editMessages
      ? {
          prepareStep: ({ messages }: { messages: ModelMessage[] }) => {
            const next = withRollingBreakpoint(clear ? clear(messages) : messages, caching)
            return {
              ...(active ? { activeTools: [...active].filter((name) => name in tools) } : {}),
              ...(editMessages ? { messages: next } : {}),
            }
          },
        }
      : {}),
    stopWhen,
    ...call,
    prompt: buildExecutorUserPrompt(input, plan, step, trace, history, view),
    abortSignal: withTimeout(signal, ctx.config.llmTimeoutMs ?? 0),
  })

  for await (const part of result.fullStream) {
    switch (part.type) {
      case 'text-delta':
        if (part.text) {
          ctx.emit({ type: 'step.text-delta', step, delta: part.text })
        }
        break
      case 'reasoning-delta':
        if (part.text && emitThoughts) {
          ctx.emit({ type: 'step.reasoning-delta', step, delta: part.text })
        }
        break
      case 'tool-call': {
        const sanitizedInput = await sanitizeForEvent(part.toolName, part.input)
        toolInputs.set(part.toolCallId, { name: part.toolName, input: sanitizedInput })
        ctx.emit({ type: 'step.tool-call', step, name: part.toolName, input: sanitizedInput })
        break
      }
      case 'tool-result': {
        // A streaming tool's intermediate values; only the final one counts.
        if ((part as { preliminary?: boolean }).preliminary) {
          break
        }
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
      : stoppedBy
        ? `Stopped early: the run's ${stoppedBy === 'tokens' ? 'token' : 'tool-call'} budget was reached after ${toolCalls.length} tool call(s).`
        : toolCalls.length > 0
          ? `Executed ${toolCalls.length} tool call(s) without producing a final message; consider raising maxStepsPerTask.`
          : 'Step produced no output.'

  return {
    summary,
    toolCalls,
    blocked,
    usage: usage ? normalizeUsage(usage) : emptyUsage(),
  }
}
