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

// Resolve the resume snapshot up-front (outside the runContext) so the runId
// reflects the original run rather than a freshly minted one. Throws on
// errors the caller should fix (no persistence, no loadRun, missing run,
// terminal status) - these are not transient, retrying won't help.
//
// Exported for direct unit testing - the validation matrix matters and
// driving it through createAgent / agent.run() is overkill.
export const resolveResume = async (
  ctx: IAgentInternalContext,
  options: IAgentRunOptions,
): Promise<IRunSnapshot | undefined> => {
  if (!options.resumeFromRunId) {
    return undefined
  }
  if (!ctx.config.persistence?.loadRun) {
    throw new Error('resumeFromRunId requires config.persistence.loadRun to be implemented')
  }
  const snapshot = await ctx.config.persistence.loadRun(options.resumeFromRunId)
  if (!snapshot) {
    throw new Error(`No persisted run found for runId "${options.resumeFromRunId}"`)
  }
  if (snapshot.status === 'complete') {
    throw new Error(`Run "${options.resumeFromRunId}" is already complete; nothing to resume`)
  }
  if (!snapshot.plan) {
    throw new Error(
      `Run "${options.resumeFromRunId}" has no saved plan (status="${snapshot.status}"); cannot resume`,
    )
  }
  return snapshot
}

export const runAgentLoop = async (
  ctx: IAgentInternalContext,
  options: IAgentRunOptions,
): Promise<IAgentRunResult> => {
  const resumed = await resolveResume(ctx, options)
  const runId = resumed?.runId ?? randomUUID()
  const startedAt = resumed?.startedAt ?? Date.now()
  const sandboxDir = resolveSandboxDir(ctx, runId)
  return runContext.run({ runId, startedAt, sandboxDir }, async () => {
    return withSpan(
      'agent.run',
      {
        [ATTR.RUN_ID]: runId,
        [ATTR.PROVIDER]: ctx.config.providerType,
        [ATTR.MODEL]: ctx.config.model,
      },
      async (span) => {
        try {
          const result = await runAgentLoopInner(ctx, options, resumed)
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
  resumed: IRunSnapshot | undefined,
): Promise<IAgentRunResult> => {
  const { signal } = options
  // On resume the saved input wins so the resumed run prompts the planner /
  // executor with the same context the original run had. Otherwise we'd
  // be silently mixing two different requests in the same trace.
  const input = resumed?.input ?? options.input
  // Snapshot history at run start: caller may keep mutating their array
  // (REPL pushes new turns after each run) but the in-flight run must see a
  // stable list. Cheap shallow copy; turns are themselves opaque to the agent.
  const history = resumed?.history
    ? [...resumed.history]
    : options.history
      ? [...options.history]
      : undefined
  const onEvent = options.onEvent ?? (() => {})

  const totalUsage: IUsage = resumed
    ? { ...resumed.usage }
    : { inputTokens: 0, outputTokens: 0, totalTokens: 0 }
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
  if (resumed) {
    // Resume path: planner already ran, plan + trace are durable. We emit a
    // synthetic plan.created so consumers attaching mid-resume see the same
    // event sequence they'd see on a fresh run.
    plan = resumed.plan as IPlan
    proxiedCtx.emit({
      type: 'log',
      level: 'info',
      message: `[resume] continuing run ${runId} from step ${resumed.trace.length}/${plan.steps.length} (iterations=${resumed.iterations}, revisions=${resumed.revisions})`,
    })
    proxiedCtx.emit({ type: 'plan.created', plan })
  } else {
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
          stepIndex: 0,
          iterations: 0,
          revisions: 0,
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
  }

  const trace: IStepResult[] = resumed ? [...resumed.trace] : []
  let currentPlan = plan
  // On resume stepIndex must equal trace.length so we don't re-run a step
  // whose result is already in the persisted trace. iterations / revisions
  // carry over so per-run caps survive across crashes.
  let stepIndex = resumed ? resumed.trace.length : 0
  let iterations = resumed?.iterations ?? 0
  let revisions = resumed?.revisions ?? 0
  const maxRevisions = ctx.config.maxRevisions ?? 2
  const tokenCap = ctx.config.maxTotalTokens

  // Skip onRunStart on resume - the original run already fired it. We don't
  // want consumers seeing two starts for the same runId.
  if (!resumed) {
    await callPersistence('onRunStart', {
      runId,
      startedAt,
      status: 'executing',
      input,
      history,
      plan: currentPlan,
      trace,
      usage: totalUsage,
      stepIndex,
      iterations,
      revisions,
    })
  }

  // Capture the post-iteration "next loop entry" state. Called at every
  // iteration boundary (clean continue / replan continue / replan revise);
  // crash recovery from the last checkpoint resumes at exactly the saved
  // stepIndex / currentPlan / trace, with no re-execution of completed steps.
  const persistCheckpoint = async (): Promise<void> => {
    await callPersistence('onStepComplete', {
      runId,
      startedAt,
      status: 'executing',
      input,
      history,
      plan: currentPlan,
      trace,
      usage: totalUsage,
      stepIndex,
      iterations,
      revisions,
    })
  }

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
          stepIndex: trace.length,
          iterations,
          revisions,
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
          stepIndex: trace.length,
          iterations,
          revisions,
          error: (err as Error).message,
          completedAt: Date.now(),
        })
        throw err
      }
    }
    trace.push(result)
    proxiedCtx.emit({ type: 'step.complete', step, result })
    // Persistence checkpoint is intentionally NOT called here. It fires at
    // the END of the iteration (after the replanner decision) so the
    // serialized stepIndex / currentPlan reflect a stable next-loop-entry
    // state. See the three persistCheckpoint() calls below.

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
      await persistCheckpoint()
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
        stepIndex,
        iterations,
        revisions,
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
      await persistCheckpoint()
      continue
    }
    stepIndex++
    await persistCheckpoint()
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
      stepIndex,
      iterations,
      revisions,
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
    stepIndex,
    iterations,
    revisions,
    text,
    completedAt: Date.now(),
  })

  return { text, plan: currentPlan, trace, iterations, usage: totalUsage }
}

const asError = (err: unknown): Error =>
  err instanceof Error ? err : new Error(typeof err === 'string' ? err : JSON.stringify(err))
