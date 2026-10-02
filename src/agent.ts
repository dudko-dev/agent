import type { LanguageModel, ToolSet } from 'ai'
import { createApprovalController, isReadOnlyTool } from './approval.ts'
import { compactionMaxTokens } from './call-options.ts'
import { compactHistory, resolveCompaction } from './compaction.ts'
import type { IAgentInternalContext } from './internal.ts'
import { connectMcpServers, filterTools } from './mcp.ts'
import { buildModelFromStage, resolveStage } from './provider.ts'
import { runAgentLoop } from './runner.ts'
import { createSkillTools, validateSkills } from './skills.ts'
import { createFindToolsTool, FIND_TOOLS_TOOL } from './tool-search.ts'
import { wrapToolSet, type IToolWrapDeps } from './tool-wrap.ts'
import type {
  AgentEvent,
  EventHandler,
  IAgentConfig,
  IAgentRunOptions,
  IAgentRunResult,
  IConversationTurn,
  IToolCatalogEntry,
  LogLevel,
  ToolApprovalMode,
} from './types.ts'

export interface ICloseOptions {
  // When true, close() polls until activeRuns reaches 0 (or timeoutMs elapses)
  // before tearing down MCP connections. Default false: close immediately and
  // let active runs fail mid-flight (the legacy behavior).
  waitForRuns?: boolean
  // Cap, in ms, applied to the entire close() call:
  //   1. when waitForRuns is true: max time spent waiting for active runs to
  //      drain;
  //   2. ALWAYS: max time spent on the underlying MCP transport teardown
  //      (some HTTP/SSE transports can hang on close if the peer is
  //      unresponsive). After this elapses close() resolves anyway and the
  //      transport is abandoned to GC. Default 30s.
  timeoutMs?: number
}

export interface ICompactOptions {
  history: IConversationTurn[]
  signal?: AbortSignal
  // Compact even below the threshold.
  force?: boolean
}

export interface ICompactResult {
  // The compacted history (the input array itself when nothing changed).
  history: IConversationTurn[]
  summary?: string
  beforeTokens: number
  afterTokens: number
  compacted: boolean
}

export interface IAgent {
  // Multiple concurrent runs are supported on a single agent instance: each
  // call gets its own runId via AsyncLocalStorage, its own usage accumulator,
  // its own abort signal, and its own onEvent. Tools and models are shared.
  // Reconnect throws if runs are in flight; close optionally waits.
  run: (options: IAgentRunOptions) => Promise<IAgentRunResult>
  // The filtered tool catalogue (MCP + native; built-ins excluded).
  listTools: () => IToolCatalogEntry[]
  // Configured skills (name + description).
  listSkills: () => { name: string; description: string }[]
  // Summarise all but the most recent turns of a history into one summary
  // turn (the synthesizer model writes it). Never throws; the input array is
  // never mutated. Without `force`, only above the compaction threshold.
  compact: (options: ICompactOptions) => Promise<ICompactResult>
  // The "autopilot toggle": applies to the next tool call, including calls
  // of runs already in flight.
  setToolApprovalMode: (mode: ToolApprovalMode) => void
  getToolApprovalMode: () => ToolApprovalMode
  // Drops the current MCP connections and reconnects with fresh headers
  // (via getHeaders if configured). Throws if any runs are in progress.
  reconnect: () => Promise<void>
  close: (options?: ICloseOptions) => Promise<void>
  activeRuns: () => number
}

const LEVEL_RANK: Record<LogLevel, number> = {
  none: 0,
  error: 1,
  warn: 2,
  info: 3,
  debug: 4,
}

export const createAgent = async (
  config: IAgentConfig,
  baseEventHandler?: EventHandler,
): Promise<IAgent> => {
  const debugMode = LEVEL_RANK[config.logLevel] >= LEVEL_RANK.debug

  const emit: EventHandler = (event: AgentEvent) => {
    if (baseEventHandler) {
      try {
        baseEventHandler(event)
      } catch (err) {
        if (debugMode) {
          // Surface handler errors only in debug mode; in normal mode they
          // are silently swallowed to keep the agent robust to bad consumers.
          // Write directly to console to avoid recursion via emit().
          console.error('[agent] event handler threw:', err)
        }
      }
    }
  }

  const log = (level: 'info' | 'warn' | 'error', message: string) => {
    if (LEVEL_RANK[config.logLevel] >= LEVEL_RANK[level]) {
      emit({ type: 'log', level, message })
    }
  }

  // ── skills, approval, built-in tools ────────────────────────────────────
  // Validated up front: a bad skill is a configuration error, not something
  // to discover mid-run.
  const skills = validateSkills(config.skills)
  // The request shows the input AFTER inputSanitizer (idempotent by
  // contract); a throwing sanitizer redacts rather than leaks.
  const sanitizeForApproval = async (name: string, input: unknown): Promise<unknown> => {
    if (!config.inputSanitizer) {
      return input
    }
    try {
      return await config.inputSanitizer(name, input)
    } catch {
      return '[input redacted: sanitizer failed]'
    }
  }
  const approval = createApprovalController(config.toolApproval, {
    sanitize: sanitizeForApproval,
    fallbackEmit: emit,
  })
  const compaction = resolveCompaction(config.compaction)
  const wrapDeps: IToolWrapDeps = {
    approval,
    maxToolCalls: config.maxToolCalls,
    maxToolOutputChars: compaction.maxToolOutputChars,
  }
  const builtinTools = wrapToolSet(createSkillTools(skills), wrapDeps, { builtIn: true })
  // find_tools exists whenever the strategy can resolve to 'search'.
  const strategy = config.toolSelectionStrategy ?? 'auto'
  const searchPossible = strategy === 'search' || strategy === 'auto'
  let searchDisabled = false
  // Live catalogue reader for find_tools (ctx is assigned below).
  let catalogRef: () => IToolCatalogEntry[] = () => []
  const findTools = searchPossible
    ? wrapToolSet(
        createFindToolsTool(() => catalogRef()),
        wrapDeps,
        { builtIn: true },
      )
    : undefined

  // Built-in names are reserved: a host / MCP tool of the same name would
  // be shadowed silently. 'auto' degrades instead of failing (it only means
  // "search when the catalogue grows"), so existing configs keep working.
  const assertNoBuiltinCollision = (tools: ToolSet): void => {
    for (const name of Object.keys(builtinTools)) {
      if (tools[name]) {
        throw new Error(`Tool "${name}" collides with a built-in skill tool of the same name`)
      }
    }
    if (findTools && tools[FIND_TOOLS_TOOL]) {
      if (strategy === 'search') {
        throw new Error(
          `Tool "${FIND_TOOLS_TOOL}" collides with the built-in tool-search tool of the same name`,
        )
      }
      if (!searchDisabled) {
        searchDisabled = true
        log(
          'warn',
          `[tools] a tool named "${FIND_TOOLS_TOOL}" shadows the built-in tool search; 'auto' stays on 'all'`,
        )
      }
    }
  }

  // Forward declaration: connectMcpServers needs the onToolsChanged callback,
  // and the callback must enqueue refreshes that drain only when activeRuns
  // reaches zero. We set the impl after the run/close machinery is wired up.
  let onToolsChanged: ((server: string) => void) | undefined
  // Merge native tools (config.tools) into a freshly filtered MCP view.
  // Called both at startup and after a tools/list_changed refresh, so native
  // entries survive MCP catalog rebuilds.
  const mergeNativeTools = (
    f: {
      tools: ReturnType<typeof filterTools>['tools']
      catalog: ReturnType<typeof filterTools>['catalog']
    },
    onCollision: (name: string) => never,
  ): {
    tools: ReturnType<typeof filterTools>['tools']
    catalog: ReturnType<typeof filterTools>['catalog']
  } => {
    if (!config.tools) {
      return f
    }
    const nativeCatalog: ReturnType<typeof filterTools>['catalog'] = []
    for (const [name, tool] of Object.entries(config.tools)) {
      if (f.tools[name]) {
        onCollision(name)
      }
      // availableTools wins over native registration, mirroring the MCP
      // path: an explicit allowlist excludes everything not on it.
      if (config.availableTools?.length && !config.availableTools.includes(name)) {
        continue
      }
      if (
        !config.availableTools?.length &&
        config.excludedTools?.length &&
        config.excludedTools.includes(name)
      ) {
        continue
      }
      f.tools[name] = tool
      const rawDesc =
        typeof tool === 'object' && tool && 'description' in tool
          ? (tool as { description?: unknown }).description
          : ''
      nativeCatalog.push({
        name,
        description: typeof rawDesc === 'string' ? rawDesc : '',
        server: '<native>',
        readOnly: isReadOnlyTool(tool),
      })
    }
    return { tools: f.tools, catalog: [...f.catalog, ...nativeCatalog] }
  }

  const connect = async () => {
    const c = await connectMcpServers(
      config.mcpServers,
      log,
      config.clientName,
      config.outputSanitizer,
      (server) => onToolsChanged?.(server),
      config.inputSanitizer,
      { connectTimeoutMs: config.mcpConnectTimeoutMs },
    )
    const f = filterTools(c.tools, c.catalog, config.availableTools, config.excludedTools, log)
    let merged: ReturnType<typeof mergeNativeTools>
    try {
      merged = mergeNativeTools(f, (name) => {
        throw new Error(
          `Native tool "${name}" collides with an MCP-registered tool of the same name`,
        )
      })
      assertNoBuiltinCollision(merged.tools)
    } catch (err) {
      // Tear the connection down so we don't leak open MCP transports when
      // the caller's misconfiguration crashes startup.
      void c.close().catch(() => {})
      throw err
    }
    return {
      connection: c,
      tools: wrapToolSet(merged.tools, wrapDeps),
      catalog: merged.catalog,
    }
  }

  let connected: Awaited<ReturnType<typeof connect>>
  try {
    connected = await connect()
  } catch (err) {
    emit({
      type: 'error',
      error: err instanceof Error ? err : new Error(String(err)),
      phase: 'init',
    })
    throw err
  }

  // Hard fail when explicitly requested and every configured server failed
  // to connect. Without this, the agent would start with zero tools, the
  // planner would produce a no-tool plan, and the user only sees the
  // problem several seconds later when execution times out. We only
  // enforce this when servers were configured at all - an agent that runs
  // tool-less by design (mcpServers: {}) is a valid use case.
  const configuredServers = Object.keys(config.mcpServers).length
  if (config.failOnNoTools && configuredServers > 0) {
    const anyConnected = connected.connection.results.some((r) => r.connected)
    if (!anyConnected) {
      const reasons = connected.connection.results
        .filter((r) => !r.connected)
        .map((r) => `${r.name}: ${r.error ?? 'unknown'}`)
        .join('; ')
      await connected.connection.close().catch(() => {})
      const err = new Error(
        `All ${configuredServers} configured MCP server(s) failed to connect [${reasons}]`,
      )
      emit({ type: 'error', error: err, phase: 'init' })
      throw err
    }
  }

  // Executor always inherits the top-level config; planner / synthesizer can
  // override any field (provider, baseURL, apiKey, model) via the dedicated
  // override blocks. Legacy plannerModel / synthesizerModel still work as
  // model-only shortcuts when the override block is absent.
  //
  // Provider SDKs are dynamically imported (peerDependencies, optional), so
  // model construction is async; build all three in parallel since they are
  // independent. On failure (e.g. missing peer dep) we MUST close the MCP
  // connection opened above - otherwise we leak open transports for what is
  // typically a misconfiguration retry-loop.
  let executorModel: LanguageModel
  let plannerModel: LanguageModel
  let synthesizerModel: LanguageModel
  try {
    const executorStage = resolveStage(config, undefined, undefined, 'executor')
    const plannerStage = resolveStage(config, config.planner, config.plannerModel, 'planner')
    const synthesizerStage = resolveStage(
      config,
      config.synthesizer,
      config.synthesizerModel,
      'synthesizer',
    )
    ;[executorModel, plannerModel, synthesizerModel] = await Promise.all([
      buildModelFromStage(config.clientName, executorStage),
      buildModelFromStage(config.clientName, plannerStage),
      buildModelFromStage(config.clientName, synthesizerStage),
    ])
  } catch (err) {
    await connected.connection.close().catch(() => {})
    emit({
      type: 'error',
      error: err instanceof Error ? err : new Error(String(err)),
      phase: 'init',
    })
    throw err
  }

  // Sorted by name, so the catalogue rendered into the (cached) planner prompt
  // is the same whatever order the servers answered in.
  const toEntries = (catalog: typeof connected.catalog): IToolCatalogEntry[] =>
    catalog
      .map((c) => ({
        name: c.name,
        description: c.description,
        server: c.server,
        readOnly: c.readOnly === true,
      }))
      .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))

  const ctx: IAgentInternalContext = {
    config,
    executorModel,
    plannerModel,
    synthesizerModel,
    tools: connected.tools,
    toolCatalog: toEntries(connected.catalog),
    emit,
    ...(Object.keys(builtinTools).length ? { builtinTools } : {}),
    ...(skills.length ? { skills } : {}),
    approval,
  }
  // Read through ctx so find_tools always searches the live catalogue
  // (refresh / reconnect replace ctx.toolCatalog).
  catalogRef = () => ctx.toolCatalog
  const syncFindTools = (): void => {
    if (findTools && !searchDisabled) {
      ctx.findTools = findTools
    } else {
      delete ctx.findTools
    }
  }
  syncFindTools()

  let activeRuns = 0
  let closed = false
  let reconnecting = false
  let refreshing = false
  // Server names whose tools/list_changed has fired but whose refresh is
  // deferred because activeRuns > 0 or another lifecycle op is in flight.
  const pendingRefreshes = new Set<string>()

  const applyRefresh = async (server: string): Promise<void> => {
    await connected.connection.refreshServer(server)
    // Re-apply the availableTools/excludedTools filter to the freshly mutated
    // raw maps, then mutate ctx.tools in place so existing closures pick up
    // the new set. The synchronous delete+assign block runs without awaits,
    // so no run() can interleave once activeRuns has been gated to 0.
    const f = filterTools(
      connected.connection.tools,
      connected.connection.catalog,
      config.availableTools,
      config.excludedTools,
    )
    // Native tools must be merged back in: filterTools/refreshServer only
    // produce the MCP view, so without this they'd vanish from ctx.tools
    // until the next reconnect.
    const merged = mergeNativeTools(f, (name) => {
      throw new Error(`Native tool "${name}" collides with an MCP-registered tool of the same name`)
    })
    assertNoBuiltinCollision(merged.tools)
    const wrapped = wrapToolSet(merged.tools, wrapDeps)
    for (const k of Object.keys(ctx.tools)) {
      delete ctx.tools[k]
    }
    Object.assign(ctx.tools, wrapped)
    ctx.toolCatalog = toEntries(merged.catalog)
    syncFindTools()
    log(
      'info',
      `[mcp] ${server}: tool list refreshed (${merged.catalog.length} tools total after filter)`,
    )
  }

  const drainPendingRefreshes = async (): Promise<void> => {
    if (refreshing || closed || reconnecting) {
      return
    }
    if (activeRuns > 0 || pendingRefreshes.size === 0) {
      return
    }
    refreshing = true
    try {
      while (pendingRefreshes.size > 0 && activeRuns === 0 && !closed && !reconnecting) {
        const next = pendingRefreshes.values().next().value as string
        pendingRefreshes.delete(next)
        try {
          await applyRefresh(next)
        } catch (err) {
          log('warn', `[mcp] ${next}: refresh failed - ${(err as Error).message}`)
        }
      }
    } finally {
      refreshing = false
    }
  }

  // Wired up here so the closure captures the lifecycle flags and
  // pendingRefreshes set declared above.
  onToolsChanged = (server: string) => {
    pendingRefreshes.add(server)
    // Sync entry into drainPendingRefreshes runs to the first await before
    // returning, so the refreshing/activeRuns gating is observed atomically
    // from any run() call that lands after this notification.
    void drainPendingRefreshes()
  }

  return {
    run: async (options: IAgentRunOptions) => {
      if (closed) {
        throw new Error('Agent is closed')
      }
      // Block new runs from racing into a mid-flight reconnect: the await on
      // connect() inside reconnect() opens a window during which ctx.tools is
      // about to be mutated. Accepting new runs in that window would let them
      // observe a half-deleted ToolSet.
      if (reconnecting) {
        throw new Error('Agent is reconnecting; retry shortly')
      }
      if (refreshing) {
        throw new Error('Agent is refreshing tools; retry shortly')
      }
      const cap = config.maxConcurrentRuns
      if (typeof cap === 'number' && cap > 0 && activeRuns >= cap) {
        // Synchronous reject: the caller should rate-limit on its side; we
        // intentionally avoid a queue so close()/reconnect() stay simple
        // (no pending-promises bookkeeping to drain).
        throw new Error(
          `maxConcurrentRuns reached (${activeRuns}/${cap}); rate-limit on the caller side or raise the cap`,
        )
      }
      activeRuns++
      try {
        return await runAgentLoop(ctx, options)
      } finally {
        activeRuns--
        // Drain deferred tool refreshes once we go quiescent. Fire-and-forget:
        // the next caller of run() either sees the refresh applied or gets
        // the 'refreshing' rejection and retries.
        void drainPendingRefreshes()
      }
    },
    listTools: () => ctx.toolCatalog.map((t) => ({ ...t })),
    listSkills: () => skills.map((s) => ({ name: s.name, description: s.description })),
    compact: async (options: ICompactOptions): Promise<ICompactResult> => {
      const r = await compactHistory(options.history, ctx.synthesizerModel, {
        thresholdTokens: compaction.thresholdTokens,
        keepRecentTurns: compaction.keepRecentTurns,
        summaryMaxTokens: compactionMaxTokens(config, compaction.summaryMaxTokens),
        force: options.force,
        signal: options.signal,
        timeoutMs: config.llmTimeoutMs,
        onUsage: (usage) => emit({ type: 'usage', phase: 'compact', usage }),
      })
      if (r.compacted) {
        emit({
          type: 'context.compacted',
          scope: 'history',
          beforeTokens: r.beforeTokens,
          afterTokens: r.afterTokens,
        })
      }
      return {
        history: r.history,
        ...(r.summary ? { summary: r.summary } : {}),
        beforeTokens: r.beforeTokens,
        afterTokens: r.afterTokens,
        compacted: r.compacted,
      }
    },
    setToolApprovalMode: (mode: ToolApprovalMode) => approval.setMode(mode),
    getToolApprovalMode: () => approval.getMode(),
    reconnect: async () => {
      if (closed) {
        throw new Error('Agent is closed')
      }
      if (reconnecting) {
        throw new Error('Already reconnecting')
      }
      if (refreshing) {
        throw new Error('Agent is refreshing tools; retry shortly')
      }
      if (activeRuns > 0) {
        throw new Error(`Cannot reconnect with ${activeRuns} active run(s)`)
      }
      reconnecting = true
      try {
        const oldConnection = connected.connection
        // Drop any deferred per-server refreshes - the new connection comes
        // up with a fresh tool listing and its own subscriptions, so the
        // pending entries are stale and would only re-trigger work.
        pendingRefreshes.clear()
        const fresh = await connect()
        // Mutate ctx.tools in place so existing closures pick up new tools.
        // The reconnecting flag held above blocks new run() calls during the
        // await + mutation window, so no concurrent reader sees inconsistent
        // state.
        for (const k of Object.keys(ctx.tools)) {
          delete ctx.tools[k]
        }
        Object.assign(ctx.tools, fresh.tools)
        ctx.toolCatalog = toEntries(fresh.catalog)
        syncFindTools()
        connected = fresh
        // Close old connections only after the new ones are wired up so a
        // failed reconnect doesn't leave the agent without tools.
        await oldConnection.close().catch(() => {})
      } finally {
        reconnecting = false
      }
    },
    close: async (options?: ICloseOptions) => {
      closed = true
      const waitForRuns = options?.waitForRuns ?? false
      const timeoutMs = options?.timeoutMs ?? 30_000
      // Single budget shared by both phases: waiting for runs to drain (if
      // requested) and the MCP transport teardown. Whatever waitForRuns
      // consumes is subtracted from what's available to the close itself,
      // with a small floor so the transport always gets *some* chance.
      const deadline = Date.now() + timeoutMs
      if (waitForRuns && activeRuns > 0) {
        // Poll instead of using EventEmitter to avoid coupling close() to
        // event-handler ordering; activeRuns flips back to 0 after the run's
        // try/finally regardless.
        while (activeRuns > 0 && Date.now() < deadline) {
          await new Promise((r) => setTimeout(r, 50))
        }
      }
      if (activeRuns > 0) {
        emit({
          type: 'log',
          level: 'warn',
          message: `[agent] close called with ${activeRuns} active run(s); they will fail mid-flight`,
        })
      }
      // Race the MCP teardown against the remaining budget. An unresponsive
      // HTTP/SSE peer can leave client.close() pending forever; the timeout
      // guarantees close() itself resolves so callers (CLIs, test fixtures)
      // never hang. Transports abandoned this way are GC'd when the agent is.
      //
      // Two tripwires we MUST get right:
      //   1. clearTimeout when MCP wins the race - otherwise the timer keeps
      //      the event loop alive for the FULL closeBudget after close()
      //      returned, and processes that called close() at the end of main
      //      visibly hang. Verified manually: with 5s budget the process
      //      exited 5s late before this clear.
      //   2. timeoutId.unref() - belt and suspenders so even an exception in
      //      the race body cannot pin the loop.
      //
      // No artificial floor: timeoutMs is a hard cap on the whole close()
      // call (per ICloseOptions docs). If waitForRuns already burned the
      // budget, we hand the teardown a 0ms slot - setTimeout(_, 0) still
      // schedules to the next tick, so transports that finish synchronously
      // can still win, but nothing here will exceed timeoutMs.
      const closeBudget = Math.max(deadline - Date.now(), 0)
      let timedOut = false
      let timeoutId: ReturnType<typeof setTimeout> | undefined
      await Promise.race([
        connected.connection.close().catch(() => {}),
        new Promise<void>((resolve) => {
          timeoutId = setTimeout(() => {
            timedOut = true
            resolve()
          }, closeBudget)
          timeoutId.unref?.()
        }),
      ])
      if (timeoutId) {
        clearTimeout(timeoutId)
      }
      if (timedOut) {
        emit({
          type: 'log',
          level: 'warn',
          message: `[agent] MCP teardown exceeded ${closeBudget}ms; abandoning transport(s)`,
        })
      }
    },
    activeRuns: () => activeRuns,
  }
}
