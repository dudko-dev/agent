import type { Tool, ToolExecutionOptions, ToolSet } from 'ai'
import { isReadOnlyTool, type IApprovalController } from './approval.ts'
import { withToolOutputLimit } from './compaction.ts'
import { runContext } from './context.ts'

export interface IToolWrapDeps {
  approval: IApprovalController
  // Cap on tool calls per run (built-ins do not count).
  maxToolCalls?: number
  // Model-visible output cap per result (0 = unlimited).
  maxToolOutputChars: number
}

const WRAPPED = Symbol.for('@dudko.dev/agent:wrapped-tool')

export class ToolBudgetError extends Error {
  constructor(cap: number) {
    super(
      `tool-call budget exhausted (maxToolCalls=${cap}). Do not call more tools; finish the step with what you have.`,
    )
    this.name = 'ToolBudgetError'
  }

  toJSON(): string {
    return this.message
  }
}

// Reserve one call of the run's tool budget; returns a release for a call
// that ends up not running (denied).
const reserveToolCall = (cap: number | undefined): (() => void) => {
  const state = runContext.getStore()?.state
  if (!state) {
    return () => {}
  }
  if (typeof cap === 'number' && cap > 0 && state.toolCalls >= cap) {
    throw new ToolBudgetError(cap)
  }
  state.toolCalls++
  return () => {
    state.toolCalls--
  }
}

const isAsyncGeneratorFunction = (fn: unknown): boolean =>
  Object.prototype.toString.call(fn) === '[object AsyncGeneratorFunction]'

/**
 * Wrap one tool's execute with the run-level gates — tool-call budget, then
 * the approval gate — and cap what the model sees of its results. The gate
 * runs INSIDE execute, so it works for every tool (MCP, native, subagent,
 * built-in) and every call path. Idempotent.
 */
export const wrapTool = (
  name: string,
  tool: Tool,
  deps: IToolWrapDeps,
  opts: { builtIn?: boolean } = {},
): Tool => {
  if ((tool as { [WRAPPED]?: boolean })[WRAPPED]) {
    return tool
  }
  const readOnly = isReadOnlyTool(tool)
  const builtIn = opts.builtIn === true
  const inner = tool.execute as
    ((input: unknown, options: ToolExecutionOptions<unknown>) => unknown) | undefined
  const before = async (input: unknown, options: ToolExecutionOptions<unknown>) => {
    const release = builtIn ? () => {} : reserveToolCall(deps.maxToolCalls)
    try {
      await deps.approval.gate(name, input, {
        readOnly,
        builtIn,
        signal: options?.abortSignal,
      })
    } catch (err) {
      release()
      throw err
    }
  }
  let execute: unknown
  if (inner) {
    execute = isAsyncGeneratorFunction(inner)
      ? async function* (input: unknown, options: ToolExecutionOptions<unknown>) {
          await before(input, options)
          yield* inner(input, options) as AsyncIterable<unknown>
        }
      : async (input: unknown, options: ToolExecutionOptions<unknown>) => {
          await before(input, options)
          return inner(input, options)
        }
  }
  const wrapped = withToolOutputLimit(
    { ...tool, ...(execute ? { execute } : {}) } as Tool,
    deps.maxToolOutputChars,
  )
  Object.defineProperty(wrapped, WRAPPED, { value: true, enumerable: false })
  return wrapped
}

export const wrapToolSet = (
  tools: ToolSet,
  deps: IToolWrapDeps,
  opts: { builtIn?: boolean } = {},
): ToolSet => {
  const out: ToolSet = {}
  for (const [name, tool] of Object.entries(tools)) {
    out[name] = wrapTool(name, tool, deps, opts)
  }
  return out
}
