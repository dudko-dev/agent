import { randomUUID } from 'node:crypto'
import { rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { runContext } from './context.ts'
import { executeStep } from './executor.ts'
import { createInitialPlan } from './planner.ts'
import { decideNextAction } from './replanner.ts'
import { synthesizeAnswer } from './synthesizer.ts'
import type { IAgentInternalContext } from './internal.ts'
import type {
  AgentEvent,
  IAgentRunOptions,
  IAgentRunResult,
  IPersistence,
  IPlan,
  IRunSnapshot,
  IStepResult,
  IUsage,
} from './types.ts'
import { ATTR, withSpan } from './tracing.ts'
import { combineSignals } from './utils.ts'

// Replanner is invoked when:
//   - the executor explicitly signalled a blocker (via the [BLOCKER] sentinel,
//     decoded into result.blocked); or
//   - any tool call in this step failed.
// Both signals are language-independent and structural, so we don't parse the
// summary's prose. shouldCallReplanner is exported for direct unit testing.
export const shouldCallReplanner = (result: IStepResult): boolean => {
  if (result.blocked) {
    return true
  }
  if (result.toolCalls.some((c) => !c.ok)) {
    return true
  }
  return false
}

const isAbortError = (err: unknown): boolean =>
  Boolean(err) && typeof err === 'object' && (err as { name?: string }).name === 'AbortError'

// Resolved here (not in context.ts) so the path policy lives next to the
// runAgentLoop that creates it on demand and tears it down at the end.
const resolveSandboxDir = (ctx: IAgentInternalContext, runId: string): string => {
  const root = ctx.config.sandboxRoot?.trim() || path.join(tmpdir(), 'agent-sandbox')
  return path.join(root, runId)
}

export const runAgentLoop = async (
  ctx: IAgentInternalContext,
  options: IAgentRunOptions,
): Promise<IAgentRunResult> => {
  const runId = randomUUID()
  const sandboxDir = resolveSandboxDir(ctx, runId)
  return runContext.run({ runId, startedAt: Date.now(), sandboxDir }, async () => {
    return withSpan(
      'agent.run',
      {
        [ATTR.RUN_ID]: runId,
        [ATTR.PROVIDER]: ctx.config.providerType,
        [ATTR.MODEL]: ctx.config.model,
      },
      async (span) => {
        try {
          const result = await runAgentLoopInner(ctx, options)
          span.setAttribute(ATTR.ITERATIONS, result.iterations)
          span.setAttribute(ATTR.USAGE_TOTAL_TOKENS, result.usage.totalTokens)
          span.setAttribute(ATTR.USAGE_INPUT_TOKENS, result.usage.inputTokens)
          span.setAttribute(ATTR.USAGE_OUTPUT_TOKENS, result.usage.outputTokens)
          return result
        } finally {
          // Best-effort cleanup. If the run never wrote anything, rm with
          // force:true is a no-op; if it did, we drop the whole subtree. The
          // catch is intentional - we'd rather leak a temp dir than throw on
          // teardown and mask the real run result.
          if (!ctx.config.keepSandbox) {
            await rm(sandboxDir, { recursive: true, force: true }).catch(() => {})
          }
        }
      },
    )
  })
}

const runAgentLoopInner = async (
  ctx: IAgentInternalContext,
  options: IAgentRunOptions,
): Promise<IAgentRunResult> => {
  const { input, signal } = options
  // Snapshot history at run start: caller may keep mutating their array
  // (REPL pushes new turns after each run) but the in-flight run must see a
  // stable list. Cheap shallow copy; turns are themselves opaque to the agent.
  const history = options.history ? [...options.history] : undefined
  const onEvent = options.onEvent ?? (() => {})

  const totalUsage: IUsage = { inputTokens: 0, outputTokens: 0, totalTokens: 0 }
  const startedAt = runContext.getStore()?.startedAt ?? Date.now()
  const runId = runContext.getStore()?.runId ?? '<unknown>'

  // Persistence facade. Hooks may be async; we await so a slow store
  // back-pressures the run. Failures are logged but never propagate -
  // persistence is observability, not a correctness boundary.
  const persistence: IPersistence | undefined = ctx.config.persistence
  const callPersistence = async (
    label: 'onRunStart' | 'onStepComplete' | 'onRunComplete',
    snapshot: IRunSnapshot,
  ): Promise<void> => {
    const fn = persistence?.[label]
    if (!fn) {
      return
    }
    try {
      await fn(snapshot)
    } catch (err) {
      ctx.emit({
        type: 'log',
        level: 'warn',
        message: `[persistence] ${label} threw: ${(err as Error).message}`,
        // tagging by emit() proxy below handles runId; but we're called
        // from within the run, so getStore is set.
      })
    }
  }

  const proxiedCtx: IAgentInternalContext = {
    ...ctx,
    emit: (event: AgentEvent) => {
      if (event.type === 'usage') {
        totalUsage.inputTokens += event.usage.inputTokens
        totalUsage.outputTokens += event.usage.outputTokens
        totalUsage.totalTokens += event.usage.totalTokens
      }
      const tagged = { ...event, runId: runContext.getStore()?.runId }
      try {
        onEvent(tagged)
      } catch {}
      try {
        ctx.emit(tagged)
      } catch {}
    },
  }

  let plan: IPlan
  try {
    plan = await createInitialPlan(input, history, proxiedCtx, signal)
  } catch (err) {
    proxiedCtx.emit({ type: 'error', error: asError(err), phase: 'plan' })
    if (isAbortError(err) || signal?.aborted) {
      await callPersistence('onRunComplete', {
        runId,
        startedAt,
        status: 'cancelled',
        input,
        history,
        trace: [],
        usage: totalUsage,
        error: (err as Error).message,
        completedAt: Date.now(),
      })
      throw err
    }
    // Graceful degradation only for non-abort failures (e.g. schema validation
    // on a small model). Falls back to a single-step "answer directly" plan
    // rather than dropping the user's request.
    plan = {
      thought: 'Planner failed; answering directly without tool use.',
      steps: [
        {
          id: 'fallback',
          description: 'Answer the user directly using prior conversation and general knowledge.',
          expectedOutcome: 'A direct answer to the user request.',
        },
      ],
    }
  }
  proxiedCtx.emit({ type: 'plan.created', plan })

  const trace: IStepResult[] = []
  let currentPlan = plan
  let stepIndex = 0
  let iterations = 0
  let revisions = 0
  const maxRevisions = ctx.config.maxRevisions ?? 2
  const tokenCap = ctx.config.maxTotalTokens

  await callPersistence('onRunStart', {
    runId,
    startedAt,
    status: 'executing',
    input,
    history,
    plan: currentPlan,
    trace,
    usage: totalUsage,
  })

  while (iterations < ctx.config.maxIterations) {
    iterations++
    if (signal?.aborted) {
      throw new DOMException('Aborted', 'AbortError')
    }
    if (stepIndex >= currentPlan.steps.length) {
      break
    }
    if (tokenCap && totalUsage.totalTokens >= tokenCap) {
      proxiedCtx.emit({ type: 'budget.exceeded', tokens: totalUsage.totalTokens, cap: tokenCap })
      break
    }

    const step = currentPlan.steps[stepIndex]
    proxiedCtx.emit({ type: 'step.start', step, index: stepIndex })

    // Per-step abort: separate from the run-level signal so the user can
    // cancel just the current step (records as blocked, replanner runs)
    // without aborting the whole run.
    const stepAC = new AbortController()
    if (options.onStepStart) {
      try {
        options.onStepStart({ step, index: stepIndex, abort: () => stepAC.abort() })
      } catch (err) {
        // Don't let a buggy callback crash the run; emit a log warn so the
        // surface is observable.
        proxiedCtx.emit({
          type: 'log',
          level: 'warn',
          message: `[step] onStepStart callback threw: ${(err as Error).message}`,
        })
      }
    }
    const stepSignal = combineSignals([signal, stepAC.signal])

    let result: IStepResult
    try {
      result = await executeStep(input, currentPlan, step, trace, history, proxiedCtx, stepSignal)
    } catch (err) {
      // Distinguish run-level abort (propagate) from step-level abort
      // (treat as blocker so the replanner gets a chance to recover).
      if (signal?.aborted) {
        proxiedCtx.emit({ type: 'error', error: asError(err), phase: 'execute' })
        await callPersistence('onRunComplete', {
          runId,
          startedAt,
          status: 'cancelled',
          input,
          history,
          plan: currentPlan,
          trace,
          usage: totalUsage,
          error: (err as Error).message,
          completedAt: Date.now(),
        })
        throw err
      }
      if (stepAC.signal.aborted && isAbortError(err)) {
        proxiedCtx.emit({
          type: 'log',
          level: 'info',
          message: `[step] aborted via onStepStart callback; replanner will decide what to do`,
        })
        result = {
          step,
          summary: '[step aborted by caller]',
          toolCalls: [],
          durationMs: 0,
          blocked: true,
        }
      } else {
        proxiedCtx.emit({ type: 'error', error: asError(err), phase: 'execute' })
        await callPersistence('onRunComplete', {
          runId,
          startedAt,
          status: 'failed',
          input,
          history,
          plan: currentPlan,
          trace,
          usage: totalUsage,
          error: (err as Error).message,
          completedAt: Date.now(),
        })
        throw err
      }
    }
    trace.push(result)
    proxiedCtx.emit({ type: 'step.complete', step, result })
    await callPersistence('onStepComplete', {
      runId,
      startedAt,
      status: 'executing',
      input,
      history,
      plan: currentPlan,
      trace,
      usage: totalUsage,
    })

    const nextStep = currentPlan.steps[stepIndex + 1] ?? null
    const isLastPlannedStep = nextStep === null

    if (isLastPlannedStep) {
      proxiedCtx.emit({
        type: 'replan.decision',
        mode: 'finish',
        reason: 'last planned step reached',
        cause: 'last-step',
      })
      break
    }

    if (!shouldCallReplanner(result)) {
      proxiedCtx.emit({
        type: 'replan.decision',
        mode: 'continue',
        reason: 'step succeeded cleanly, skipping LLM replanner',
        cause: 'clean-step',
      })
      stepIndex++
      continue
    }

    let decision
    try {
      decision = await decideNextAction(input, currentPlan, trace, nextStep, proxiedCtx, signal)
    } catch (err) {
      proxiedCtx.emit({ type: 'error', error: asError(err), phase: 'replan' })
      await callPersistence('onRunComplete', {
        runId,
        startedAt,
        status: isAbortError(err) || signal?.aborted ? 'cancelled' : 'failed',
        input,
        history,
        plan: currentPlan,
        trace,
        usage: totalUsage,
        error: (err as Error).message,
        completedAt: Date.now(),
      })
      throw err
    }
    proxiedCtx.emit({
      type: 'replan.decision',
      mode: decision.mode,
      reason: decision.reason,
      cause: 'llm-decision',
    })

    if (decision.mode === 'finish') {
      break
    }
    if (decision.mode === 'revise') {
      if (revisions >= maxRevisions) {
        proxiedCtx.emit({ type: 'revisions.exceeded', cap: maxRevisions })
        break
      }
      revisions++
      currentPlan = decision.newPlan
      proxiedCtx.emit({ type: 'plan.revised', plan: currentPlan, reason: decision.reason })
      stepIndex = 0
      continue
    }
    stepIndex++
  }

  let text: string
  try {
    text = await synthesizeAnswer(input, currentPlan, trace, history, proxiedCtx, signal)
  } catch (err) {
    proxiedCtx.emit({ type: 'error', error: asError(err), phase: 'synthesize' })
    await callPersistence('onRunComplete', {
      runId,
      startedAt,
      status: isAbortError(err) || signal?.aborted ? 'cancelled' : 'failed',
      input,
      history,
      plan: currentPlan,
      trace,
      usage: totalUsage,
      error: (err as Error).message,
      completedAt: Date.now(),
    })
    throw err
  }
  proxiedCtx.emit({ type: 'final', text })
  await callPersistence('onRunComplete', {
    runId,
    startedAt,
    status: 'complete',
    input,
    history,
    plan: currentPlan,
    trace,
    usage: totalUsage,
    text,
    completedAt: Date.now(),
  })

  return { text, plan: currentPlan, trace, iterations, usage: totalUsage }
}

const asError = (err: unknown): Error =>
  err instanceof Error ? err : new Error(typeof err === 'string' ? err : JSON.stringify(err))
