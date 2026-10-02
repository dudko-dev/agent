import { randomUUID } from 'node:crypto'
import { rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { compactionMaxTokens } from './call-options.ts'
import { compactHistory, estimateTokens, resolveCompaction, summarizeTrace } from './compaction.ts'
import { runContext } from './context.ts'
import { executeStep } from './executor.ts'
import { checkLimits, resolveLimits } from './limits.ts'
import { createInitialPlan, filterPlanSkills, planStepCap } from './planner.ts'
import { renderTrace, renderTraceSteps } from './prompts.ts'
import { decideNextAction } from './replanner.ts'
import { activateSkill } from './skills.ts'
import { synthesizeAnswer } from './synthesizer.ts'
import { resolveToolStrategy } from './tool-search.ts'
import type { EffectiveToolStrategy, IAgentInternalContext, IRunState } from './internal.ts'
import type {
  AgentEvent,
  BudgetKind,
  IAgentRunOptions,
  IAgentRunResult,
  IConversationTurn,
  IPersistence,
  IPlan,
  IRunSnapshot,
  IStepResult,
  ReplanTrigger,
} from './types.ts'
import { ATTR, withSpan } from './tracing.ts'
import { accumulateUsage, combineSignals, normalizeUsage } from './utils.ts'

// The default ('failure') replan trigger fires when:
//   - the executor explicitly signalled a blocker (via the [BLOCKER] sentinel,
//     decoded into result.blocked); or
//   - a tool call in this step failed and STAYED failed. A failure that a
//     later call to the same tool retried successfully is self-corrected -
//     the executor's multi-step loop already recovered, so it must not force
//     a replan.
// Both signals are language-independent and structural, so we don't parse the
// summary's prose. shouldCallReplanner is exported for direct unit testing.
export const shouldCallReplanner = (result: IStepResult): boolean => {
  if (result.blocked) {
    return true
  }
  const { toolCalls } = result
  return toolCalls.some(
    (c, i) => !c.ok && !toolCalls.slice(i + 1).some((later) => later.ok && later.name === c.name),
  )
}

export interface IReplanTriggerOptions {
  signal?: AbortSignal
  timeoutMs?: number
  // Called with whatever a host predicate threw before falling back to 'failure'.
  onError?: (err: unknown) => void
}

// Resolve the configured `replanAfter` trigger for one step result. 'failure'
// is the classic shouldCallReplanner; 'always' consults the replanner after
// every step; a host predicate decides per result. A predicate that throws,
// rejects, or outlives the watchdog/abort falls back to 'failure' behaviour so
// a buggy or hung predicate can never stall the run.
export const replanTriggered = async (
  trigger: ReplanTrigger | undefined,
  result: IStepResult,
  opts: IReplanTriggerOptions = {},
): Promise<boolean> => {
  if (trigger === 'always') {
    return true
  }
  if (typeof trigger !== 'function') {
    return shouldCallReplanner(result)
  }
  const fallback = (): boolean => shouldCallReplanner(result)
  const { signal } = opts
  const timeoutMs = opts.timeoutMs ?? 0
  if (signal?.aborted) {
    return fallback()
  }
  // Never rejects: a sync throw or async rejection resolves to the fallback.
  const decided = (async (): Promise<boolean> => {
    try {
      return Boolean(await trigger(result))
    } catch (err) {
      opts.onError?.(err)
      return fallback()
    }
  })()
  const hasTimeout = Number.isFinite(timeoutMs) && timeoutMs > 0
  if (!hasTimeout && !signal) {
    // No watchdog configured - just await the predicate.
    return decided
  }
  // Watchdog: fall back when the timeout elapses or the run aborts. We use a
  // ref'd setTimeout rather than AbortSignal.timeout on purpose - an
  // AbortSignal.timeout timer is unref'd, so a hung predicate on an otherwise
  // idle event loop could let the process exit before the fallback lands
  // (and node:test on Node 22 tears the loop down early, cancelling the test).
  // A ref'd timer keeps the loop alive until the fallback resolves.
  return new Promise<boolean>((resolve) => {
    let settled = false
    let timer: ReturnType<typeof setTimeout> | undefined
    const finish = (value: boolean): void => {
      if (settled) {
        return
      }
      settled = true
      if (timer !== undefined) {
        clearTimeout(timer)
      }
      signal?.removeEventListener('abort', onAbort)
      resolve(value)
    }
    function onAbort(): void {
      finish(fallback())
    }
    if (hasTimeout) {
      timer = setTimeout(() => finish(fallback()), timeoutMs)
    }
    signal?.addEventListener('abort', onAbort, { once: true })
    decided.then(finish, () => finish(fallback()))
  })
}

const isAbortError = (err: unknown): boolean =>
  Boolean(err) && typeof err === 'object' && (err as { name?: string }).name === 'AbortError'

// Resolved here (not in context.ts) so the path policy lives next to the
// runAgentLoop that creates it on demand and tears it down at the end.
const resolveSandboxDir = (ctx: IAgentInternalContext, runId: string): string => {
  const root = ctx.config.sandboxRoot?.trim() || path.join(tmpdir(), 'agent-sandbox')
  return path.join(root, runId)
}

// Defence-in-depth: runIds end up in filesystem paths (sandboxDir =
// <root>/<runId>/), so anything that lets a caller-controlled string flow
// through must be normalised. We accept the UUID form randomUUID() emits
// plus the slightly broader alphanumeric+_- charset commonly used by
// custom persistence layers. Path separators, dots, and unicode are out.
const RUN_ID_PATTERN = /^[a-zA-Z0-9_-]{1,128}$/
const assertSafeRunId = (id: string, source: string): void => {
  if (!RUN_ID_PATTERN.test(id)) {
    throw new Error(
      `Unsafe runId from ${source}: must match ${RUN_ID_PATTERN}, got ${JSON.stringify(id)}`,
    )
  }
}

// Resolve the resume snapshot up-front (outside the runContext) so the runId
// reflects the original run rather than a freshly minted one. Throws on
// errors the caller should fix (no persistence, no loadRun, missing run,
// terminal status, malformed runId) - these are not transient, retrying
// won't help.
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
  assertSafeRunId(options.resumeFromRunId, 'options.resumeFromRunId')
  if (!ctx.config.persistence?.loadRun) {
    throw new Error('resumeFromRunId requires config.persistence.loadRun to be implemented')
  }
  const snapshot = await ctx.config.persistence.loadRun(options.resumeFromRunId)
  if (!snapshot) {
    throw new Error(`No persisted run found for runId "${options.resumeFromRunId}"`)
  }
  // Persistence is user-controlled; a malicious / bugged adapter could
  // return a snapshot with a different runId than the one we asked for, or
  // a runId that escapes the sandbox path. Validate both.
  assertSafeRunId(snapshot.runId, 'snapshot.runId')
  if (snapshot.runId !== options.resumeFromRunId) {
    throw new Error(
      `Persistence returned runId "${snapshot.runId}" for resumeFromRunId "${options.resumeFromRunId}"; refusing to resume on mismatch`,
    )
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
  // Belt-and-braces: resolveResume already validates resumed.runId, but the
  // fresh-run path also lands here. randomUUID() is always safe; the assert
  // is a no-op under that path and a hard guard against any future caller
  // that supplies a runId by other means.
  assertSafeRunId(runId, 'runId')
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

// The run's effective tool strategy: 'auto' resolved against the live
// catalogue size, and 'search' only when find_tools is available.
const runToolStrategy = (ctx: IAgentInternalContext): EffectiveToolStrategy => {
  const s = resolveToolStrategy(ctx.config, ctx.toolCatalog.length)
  return s === 'search' && !ctx.findTools ? 'all' : s
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
  // History follows the same rule for symmetry - the original run's history
  // is what shaped the saved trace, so we keep it. Documented in README.
  const input = resumed?.input ?? options.input
  let history: IConversationTurn[] | undefined = resumed?.history
    ? [...resumed.history]
    : options.history
      ? [...options.history]
      : undefined
  const onEvent = options.onEvent ?? (() => {})
  const compaction = resolveCompaction(ctx.config.compaction)
  const limits = resolveLimits(ctx.config)
  const maxToolCalls = ctx.config.maxToolCalls

  // Every IUsage detail is filled (normalizeUsage) so accumulation never
  // produces NaN on a snapshot written by an older version.
  const totalUsage = normalizeUsage(resumed?.usage)
  const startedAt = runContext.getStore()?.startedAt ?? Date.now()
  const runId = runContext.getStore()?.runId ?? '<unknown>'

  // Per-run state shared with the stages and (through the run context) with
  // the tool wrappers.
  const state: IRunState = {
    usage: totalUsage,
    toolCalls: resumed?.toolCallCount ?? 0,
    strategy: runToolStrategy(ctx),
    discovered: [],
    activeSkills: [...(resumed?.activeSkills ?? [])],
    traceSummary: resumed?.traceSummary,
    traceSummaryUpTo: resumed?.traceSummaryUpTo ?? 0,
  }

  // proxiedCtx must be in scope BEFORE callPersistence so the persistence
  // error log carries the runId tag (the proxy attaches it; ctx.emit alone
  // does not). Order of declaration matters here.
  const proxiedCtx: IAgentInternalContext = {
    ...ctx,
    run: state,
    emit: (event: AgentEvent) => {
      if (event.type === 'usage') {
        accumulateUsage(totalUsage, event.usage)
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
  const store = runContext.getStore()
  if (store) {
    store.emit = proxiedCtx.emit
    store.state = state
  }
  const activate = (name: string, by: 'plan' | 'tool'): void => {
    activateSkill(ctx.skills ?? [], name, by, state, proxiedCtx.emit)
  }

  // Persistence facade. Hooks may be async; we await so a slow store
  // back-pressures the run. Write-hook failures are logged but never
  // propagate - persistence is observability, not a correctness boundary.
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
      proxiedCtx.emit({
        type: 'log',
        level: 'warn',
        message: `[persistence] ${label} threw: ${(err as Error).message}`,
      })
    }
  }

  // Automatic history compaction (fresh runs only - a resumed run already
  // carries the history its trace was built from). The run works on the
  // compacted copy; the caller's array is never mutated and gets the copy
  // back as result.compactedHistory.
  let compactedHistory: IConversationTurn[] | undefined
  if (!resumed && history?.length && compaction.auto) {
    const r = await compactHistory(history, ctx.synthesizerModel, {
      thresholdTokens: compaction.thresholdTokens,
      keepRecentTurns: compaction.keepRecentTurns,
      summaryMaxTokens: compactionMaxTokens(ctx.config, compaction.summaryMaxTokens),
      signal,
      timeoutMs: ctx.config.llmTimeoutMs,
      onUsage: (usage) => proxiedCtx.emit({ type: 'usage', phase: 'compact', usage }),
    })
    if (r.compacted) {
      history = r.history
      compactedHistory = r.history
      proxiedCtx.emit({
        type: 'context.compacted',
        scope: 'history',
        beforeTokens: r.beforeTokens,
        afterTokens: r.afterTokens,
      })
    }
  }

  // Automatic trace compaction, before each executor / replanner /
  // synthesizer call: once the rendered trace crosses the threshold, every
  // step but the last keepRecentSteps is folded into a running summary.
  // The trace itself stays intact (result, persistence, events).
  const maybeCompactTrace = async (trace: IStepResult[]): Promise<void> => {
    if (!compaction.auto || signal?.aborted) {
      return
    }
    const view = () => ({ summary: state.traceSummary, upTo: state.traceSummaryUpTo })
    const beforeTokens = estimateTokens(renderTrace(trace, view()))
    if (beforeTokens <= compaction.thresholdTokens) {
      return
    }
    const upTo = trace.length - compaction.keepRecentSteps
    const from = state.traceSummary ? state.traceSummaryUpTo : 0
    if (upTo <= from) {
      return
    }
    const r = await summarizeTrace(
      trace.slice(from, upTo),
      state.traceSummary,
      ctx.synthesizerModel,
      {
        summaryMaxTokens: compactionMaxTokens(ctx.config, compaction.summaryMaxTokens),
        signal,
        timeoutMs: ctx.config.llmTimeoutMs,
        render: renderTraceSteps,
        offset: from,
      },
    )
    if (!r) {
      return
    }
    proxiedCtx.emit({ type: 'usage', phase: 'compact', usage: r.usage })
    state.traceSummary = r.summary
    state.traceSummaryUpTo = upTo
    proxiedCtx.emit({
      type: 'context.compacted',
      scope: 'trace',
      beforeTokens,
      afterTokens: estimateTokens(renderTrace(trace, view())),
    })
  }

  // Run-level budgets: token limits (legacy maxTotalTokens included) and the
  // tool-call cap. Reported once per run.
  let budgetReported = false
  const budgetBreach = (): { kind: BudgetKind; tokens: number; cap: number } | undefined => {
    const tokens = checkLimits(totalUsage, limits)
    if (tokens) {
      return tokens
    }
    if (typeof maxToolCalls === 'number' && maxToolCalls > 0 && state.toolCalls >= maxToolCalls) {
      return { kind: 'tool-calls', tokens: state.toolCalls, cap: maxToolCalls }
    }
    return undefined
  }
  const reportBudget = (): boolean => {
    const breach = budgetBreach()
    if (!breach) {
      return false
    }
    if (!budgetReported) {
      budgetReported = true
      proxiedCtx.emit({ type: 'budget.exceeded', ...breach })
    }
    return true
  }

  let plan: IPlan
  if (resumed) {
    // Resume path: planner already ran, plan + trace are durable. The
    // synthetic plan.created on resume is a deliberate compromise so
    // consumers that attach mid-resume see the canonical plan shape they
    // expect; consumers that store the original event already saw it once.
    // Document as part of the resume contract (README.md).
    plan = resumed.plan as IPlan
    proxiedCtx.emit({
      type: 'log',
      level: 'info',
      message: `[resume] continuing run ${runId} from step ${resumed.stepIndex}/${plan.steps.length} (iterations=${resumed.iterations}, revisions=${resumed.revisions})`,
    })
    proxiedCtx.emit({ type: 'plan.created', plan })
  } else {
    try {
      plan = await createInitialPlan(input, history, proxiedCtx, signal)
    } catch (err) {
      proxiedCtx.emit({ type: 'error', error: asError(err), phase: 'plan' })
      if (isAbortError(err) || signal?.aborted) {
        // Pre-plan failure: no currentPlan / trace yet, so we hand-build the
        // snapshot rather than going through buildSnapshot below (which
        // closes over those mutable bindings).
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
    for (const name of plan.skills ?? []) {
      activate(name, 'plan')
    }
  }

  const trace: IStepResult[] = resumed ? [...resumed.trace] : []
  let currentPlan = plan
  // The saved stepIndex is the LOCAL "next index in currentPlan.steps" value,
  // NOT trace.length. They diverge after a replan revise: trace carries
  // pre-revise steps while stepIndex is reset to 0 against the new plan. Use
  // resumed.stepIndex directly so we don't skip steps in the post-revise plan.
  let stepIndex = resumed?.stepIndex ?? 0
  let iterations = resumed?.iterations ?? 0
  let revisions = resumed?.revisions ?? 0
  const maxRevisions = ctx.config.maxRevisions ?? 2

  // Build a complete snapshot for the current loop state. Centralises the
  // 14-field literal that used to be repeated at every persistence call site.
  const buildSnapshot = (
    status: IRunSnapshot['status'],
    extra: Partial<IRunSnapshot> = {},
  ): IRunSnapshot => ({
    runId,
    startedAt,
    status,
    input,
    history,
    plan: currentPlan,
    trace,
    usage: totalUsage,
    stepIndex,
    iterations,
    revisions,
    ...(state.traceSummary
      ? { traceSummary: state.traceSummary, traceSummaryUpTo: state.traceSummaryUpTo }
      : {}),
    ...(state.activeSkills.length ? { activeSkills: [...state.activeSkills] } : {}),
    ...(state.toolCalls ? { toolCallCount: state.toolCalls } : {}),
    ...extra,
  })

  // Skip onRunStart on resume - the original run already fired it. We don't
  // want consumers seeing two starts for the same runId.
  if (!resumed) {
    await callPersistence('onRunStart', buildSnapshot('executing'))
  }

  // Capture the post-iteration "next loop entry" state. Called at every
  // iteration boundary (clean continue / replan continue / replan revise);
  // crash recovery from the last checkpoint resumes at exactly the saved
  // stepIndex / currentPlan / trace, with no re-execution of completed steps.
  const persistCheckpoint = async (): Promise<void> => {
    await callPersistence('onStepComplete', buildSnapshot('executing'))
  }

  while (iterations < ctx.config.maxIterations) {
    if (signal?.aborted) {
      throw new DOMException('Aborted', 'AbortError')
    }
    if (stepIndex >= currentPlan.steps.length) {
      break
    }
    if (reportBudget()) {
      break
    }
    // Increment AFTER the early-break checks so iterations counts only
    // iterations that actually ran a step; an early break on token cap or
    // last-step doesn't inflate result.iterations by 1.
    iterations++

    const step = currentPlan.steps[stepIndex]
    if (store) {
      store.currentStep = step
    }
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
      await maybeCompactTrace(trace)
      result = await executeStep(input, currentPlan, step, trace, history, proxiedCtx, stepSignal)
    } catch (err) {
      // Distinguish run-level abort (propagate) from step-level abort
      // (treat as blocker so the replanner gets a chance to recover).
      if (signal?.aborted) {
        proxiedCtx.emit({ type: 'error', error: asError(err), phase: 'execute' })
        await callPersistence(
          'onRunComplete',
          buildSnapshot('cancelled', {
            error: (err as Error).message,
            completedAt: Date.now(),
          }),
        )
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
        await callPersistence(
          'onRunComplete',
          buildSnapshot('failed', {
            error: (err as Error).message,
            completedAt: Date.now(),
          }),
        )
        throw err
      }
    }
    trace.push(result)
    proxiedCtx.emit({ type: 'step.complete', step, result })
    // Persistence checkpoint is intentionally NOT called here. It fires at
    // the END of the iteration (after the replanner decision) so the
    // serialized stepIndex / currentPlan reflect a stable next-loop-entry
    // state. See the three persistCheckpoint() calls below.

    // A budget crossed during the step ends execution right here: no
    // replanner call, straight to synthesis.
    if (reportBudget()) {
      stepIndex++
      break
    }

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

    // The trigger is host-configurable (replanAfter); a predicate is bounded
    // by the same watchdog/abort as an LLM call and falls back to the
    // 'failure' rule on error, so it can never stall the run.
    const wantReplanner = await replanTriggered(ctx.config.replanAfter, result, {
      signal,
      timeoutMs: ctx.config.llmTimeoutMs ?? 0,
      onError: (err) =>
        proxiedCtx.emit({
          type: 'log',
          level: 'warn',
          message: `[runner] replanAfter predicate threw - using the failure rule: ${(err as Error).message}`,
        }),
    })
    if (!wantReplanner) {
      proxiedCtx.emit({
        type: 'replan.decision',
        mode: 'continue',
        reason: 'replan trigger not met, skipping LLM replanner',
        cause: 'clean-step',
      })
      stepIndex++
      await persistCheckpoint()
      continue
    }

    let decision
    try {
      await maybeCompactTrace(trace)
      decision = await decideNextAction(input, currentPlan, trace, nextStep, proxiedCtx, signal)
    } catch (err) {
      proxiedCtx.emit({ type: 'error', error: asError(err), phase: 'replan' })
      await callPersistence(
        'onRunComplete',
        buildSnapshot(isAbortError(err) || signal?.aborted ? 'cancelled' : 'failed', {
          error: (err as Error).message,
          completedAt: Date.now(),
        }),
      )
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
      currentPlan = reviseInto(proxiedCtx, decision.newPlan)
      proxiedCtx.emit({ type: 'plan.revised', plan: currentPlan, reason: decision.reason })
      for (const name of currentPlan.skills ?? []) {
        activate(name, 'plan')
      }
      stepIndex = 0
      await persistCheckpoint()
      continue
    }
    stepIndex++
    await persistCheckpoint()
  }

  let text: string
  try {
    await maybeCompactTrace(trace)
    text = await synthesizeAnswer(input, currentPlan, trace, history, proxiedCtx, signal)
  } catch (err) {
    proxiedCtx.emit({ type: 'error', error: asError(err), phase: 'synthesize' })
    await callPersistence(
      'onRunComplete',
      buildSnapshot(isAbortError(err) || signal?.aborted ? 'cancelled' : 'failed', {
        error: (err as Error).message,
        completedAt: Date.now(),
      }),
    )
    throw err
  }
  proxiedCtx.emit({ type: 'final', text })
  await callPersistence(
    'onRunComplete',
    buildSnapshot('complete', {
      text,
      completedAt: Date.now(),
    }),
  )

  return {
    text,
    plan: currentPlan,
    trace,
    iterations,
    usage: totalUsage,
    ...(compactedHistory ? { compactedHistory } : {}),
  }
}

// A revised plan follows the planner's rules too: the same step cap and
// only configured skills.
const reviseInto = (ctx: IAgentInternalContext, plan: IPlan): IPlan => {
  const cap = planStepCap(ctx)
  if (plan.steps.length > cap) {
    ctx.emit({
      type: 'log',
      level: 'warn',
      message: `[replan] revised plan has ${plan.steps.length} steps; truncated to hard cap ${cap}`,
    })
  }
  const skills = filterPlanSkills(ctx, plan.skills)
  const { skills: _drop, ...rest } = plan
  return { ...rest, steps: plan.steps.slice(0, cap), ...(skills ? { skills } : {}) }
}

const asError = (err: unknown): Error =>
  err instanceof Error ? err : new Error(typeof err === 'string' ? err : JSON.stringify(err))
