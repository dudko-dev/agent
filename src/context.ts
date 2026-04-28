import { AsyncLocalStorage } from 'node:async_hooks'

export interface IRunContext {
  runId: string
  startedAt: number
  // Absolute path to this run's sandbox subdirectory. Created lazily by the
  // first tool that needs to spill binary content; consumers can probe it
  // via getCurrentRunSandbox() and write into it directly.
  sandboxDir: string
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

// Absolute path to the active run's sandbox directory. Returns undefined
// when called outside of an agent.run() (e.g. setup code) - tools that need
// the path should treat undefined as "no sandbox, store in memory".
export const getCurrentRunSandbox = (): string | undefined => runContext.getStore()?.sandboxDir
