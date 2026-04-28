import { AsyncLocalStorage } from 'node:async_hooks'

export interface IRunContext {
  runId: string
  startedAt: number
}

// Per-run context. Propagates through awaits, so any code reachable from
// runAgentLoop (planner, executor, MCP tool execute, retry sleeps, ...) can
// read the current runId without it being threaded through every function.
//
// Multi-session safety: each agent.run() call wraps its body in
// runContext.run(...), so concurrent runs on the same agent see different
// stores even when their async tasks interleave on the event loop.
export const runContext = new AsyncLocalStorage<IRunContext>()

export const getCurrentRunId = (): string | undefined => runContext.getStore()?.runId
