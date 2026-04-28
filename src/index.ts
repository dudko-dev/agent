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

export { getCurrentRunId } from './context.ts'
export { redactHeaders } from './utils.ts'

export type {
  AgentEvent,
  EventHandler,
  IAgentConfig,
  IAgentRunOptions,
  IAgentRunResult,
  IConversationTurn,
  IMcpServerConfig,
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

  const connect = async () => {
    const c = await connectMcpServers(
      config.mcpServers,
      log,
      config.clientName,
      config.outputSanitizer,
    )
    const f = filterTools(c.tools, c.catalog, config.availableTools, config.excludedTools)
    return { connection: c, tools: f.tools, catalog: f.catalog }
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
      activeRuns++
      try {
        return await runAgentLoop(ctx, options)
      } finally {
        activeRuns--
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
      if (activeRuns > 0) {
        throw new Error(`Cannot reconnect with ${activeRuns} active run(s)`)
      }
      reconnecting = true
      try {
        const oldConnection = connected.connection
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
