import type { IAgentInternalContext } from './internal.ts'
import { connectMcpServers, filterTools } from './mcp.ts'
import { buildModel } from './provider.ts'
import { runAgentLoop } from './runner.ts'
import type {
  AgentEvent,
  EventHandler,
  IAgentConfig,
  IAgentRunOptions,
  IAgentRunResult,
  LogLevel,
} from './types.ts'

export { getCurrentRunId, getCurrentRunSandbox } from './context.ts'
export { redactHeaders } from './utils.ts'

export type {
  AgentEvent,
  EventHandler,
  IAgentConfig,
  IAgentRunOptions,
  IAgentRunResult,
  IConversationTurn,
  IMcpHttpServerConfig,
  IMcpServerConfig,
  IMcpStdioServerConfig,
  IPlan,
  IPlanStep,
  IStepResult,
  IUsage,
  LogLevel,
  ProviderType,
  ReplanCause,
  ToolSelectionStrategy,
} from './types.ts'

export interface ICloseOptions {
  // When true, close() polls until activeRuns reaches 0 (or timeoutMs elapses)
  // before tearing down MCP connections. Default false: close immediately and
  // let active runs fail mid-flight (the legacy behavior).
  waitForRuns?: boolean
  // Maximum time to wait for active runs when waitForRuns is true. Default 30s.
  timeoutMs?: number
}

export interface IAgent {
  // Multiple concurrent runs are supported on a single agent instance: each
  // call gets its own runId via AsyncLocalStorage, its own usage accumulator,
  // its own abort signal, and its own onEvent. Tools and models are shared.
  // Reconnect throws if runs are in flight; close optionally waits.
  run: (options: IAgentRunOptions) => Promise<IAgentRunResult>
  listTools: () => { name: string; description: string }[]
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
    )
    const f = filterTools(c.tools, c.catalog, config.availableTools, config.excludedTools)
    const merged = mergeNativeTools(f, (name) => {
      // Tear the connection down so we don't leak open MCP transports when
      // the caller's misconfiguration crashes startup.
      void c.close().catch(() => {})
      throw new Error(`Native tool "${name}" collides with an MCP-registered tool of the same name`)
    })
    return { connection: c, tools: merged.tools, catalog: merged.catalog }
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

  const executorModel = buildModel(config, config.model)
  const plannerModel = buildModel(config, config.plannerModel ?? config.model)
  const synthesizerModel = buildModel(config, config.synthesizerModel ?? config.model)

  const ctx: IAgentInternalContext = {
    config,
    executorModel,
    plannerModel,
    synthesizerModel,
    tools: connected.tools,
    toolCatalog: connected.catalog.map((c) => ({ name: c.name, description: c.description })),
    emit,
  }

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
    for (const k of Object.keys(ctx.tools)) {
      delete ctx.tools[k]
    }
    Object.assign(ctx.tools, merged.tools)
    ctx.toolCatalog = merged.catalog.map((c) => ({ name: c.name, description: c.description }))
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
    listTools: () => ctx.toolCatalog.slice(),
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
        ctx.toolCatalog = fresh.catalog.map((c) => ({ name: c.name, description: c.description }))
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
      if (waitForRuns && activeRuns > 0) {
        const start = Date.now()
        // Poll instead of using EventEmitter to avoid coupling close() to
        // event-handler ordering; activeRuns flips back to 0 after the run's
        // try/finally regardless.
        while (activeRuns > 0 && Date.now() - start < timeoutMs) {
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
      await connected.connection.close().catch(() => {})
    },
    activeRuns: () => activeRuns,
  }
}
