import { asSchema, tool, type Tool, type ToolExecutionOptions, type ToolSet } from 'ai'
import { randomUUID } from 'node:crypto'
import { AsyncResource } from 'node:async_hooks'
import { Worker } from 'node:worker_threads'
import { z } from 'zod'
import { createAgent } from './agent.ts'
import { isReadOnlyTool, markReadOnly } from './approval.ts'
import { runContext } from './context.ts'
import type { AgentEvent, EventHandler, IAgentConfig, IUsage } from './types.ts'
import { clipText, emptyUsage, errorMessage, normalizeUsage } from './utils.ts'

export type SubagentIsolation = 'worker' | 'in-process'

export interface ISubagentToolOptions {
  // Tool name the parent model calls.
  name: string
  // When the parent should delegate to this subagent.
  description: string
  // The child agent's config. With 'worker' isolation it must be
  // structured-cloneable: no functions anywhere (getHeaders, authProvider,
  // fetch, sanitizers, persistence, onRequest, native tools...).
  config: IAgentConfig
  // 'worker' (default): the child runs in its own worker_thread - its CPU
  // work and crashes stay off the parent's event loop. 'in-process': the
  // child is a plain agent on this thread.
  isolation?: SubagentIsolation
  // Host tools for the child. In-process: merged into config.tools. Worker:
  // PROXIED - the child sees their schemas, every call runs here on the
  // parent thread.
  tools?: ToolSet
  // Parallel calls of this tool beyond this many queue. Default 4.
  maxConcurrent?: number
  // Abort the child after this many ms. Default: none.
  timeoutMs?: number
  // The child's final text is clipped to this. Default 8_000.
  outputMaxChars?: number
  // Mark the tool read-only for tool approval. Default false.
  readOnly?: boolean
}

// ── worker protocol (JSON-cloneable) ─────────────────────────────────────
export interface IProxiedToolDescriptor {
  name: string
  description: string
  inputSchema: unknown
  readOnly?: boolean
}

export type ParentToWorkerMessage =
  | { type: 'run'; task: string; config: IAgentConfig; proxied: IProxiedToolDescriptor[] }
  | { type: 'abort' }
  | { type: 'tool-result'; callId: string; ok: boolean; output: unknown }

export type WorkerToParentMessage =
  | { type: 'event'; event: AgentEvent }
  | { type: 'tool-call'; callId: string; name: string; input: unknown }
  | { type: 'done'; text: string; usage: IUsage; iterations: number }
  | { type: 'error'; error: string }

const DEFAULT_OUTPUT_MAX_CHARS = 8_000
const DEFAULT_MAX_CONCURRENT = 4
const EVENT_STRING_MAX = 4_000

// JSON round-trip that turns Errors into their message and drops what JSON
// cannot carry. The fallback when structuredClone refuses a payload.
const jsonSafe = (value: unknown): unknown => {
  try {
    const s = JSON.stringify(value, (_k, v: unknown) =>
      v instanceof Error ? v.message : typeof v === 'bigint' ? v.toString() : v,
    )
    return s === undefined ? undefined : JSON.parse(s)
  } catch {
    return String(value)
  }
}

// Structured-cloneable copy of a payload (worker messages).
export const toCloneable = <T>(value: T): T => {
  try {
    return structuredClone(value)
  } catch {
    return jsonSafe(value) as T
  }
}

const clipStrings = (value: unknown, depth = 0): unknown => {
  if (typeof value === 'string') {
    return clipText(value, EVENT_STRING_MAX)
  }
  if (value instanceof Error) {
    return value
  }
  if (!value || typeof value !== 'object' || depth > 8) {
    return value
  }
  if (Array.isArray(value)) {
    return value.map((v) => clipStrings(v, depth + 1))
  }
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(value)) {
    out[k] = clipStrings(v, depth + 1)
  }
  return out
}

// A child event as forwarded to the parent: verbatim, long strings clipped.
export const slimEvent = (event: AgentEvent): AgentEvent => clipStrings(event) as AgentEvent

/**
 * Throws naming the first function-valued field of a config that has to
 * cross into a worker thread (functions are not structured-cloneable).
 */
export const assertWorkerSafeConfig = (config: IAgentConfig, label = 'config'): void => {
  if (config.tools && Object.keys(config.tools).length) {
    throw new Error(
      `${label}.tools cannot cross into a worker thread; use the \`tools\` option of createSubagentTool to proxy host tools (or isolation: 'in-process')`,
    )
  }
  const seen = new Set<unknown>()
  const walk = (value: unknown, path: string): void => {
    if (typeof value === 'function') {
      throw new Error(
        `${path} is a function and cannot cross into a worker thread; use the \`tools\` option to proxy host tools, or isolation: 'in-process'`,
      )
    }
    if (!value || typeof value !== 'object' || seen.has(value)) {
      return
    }
    seen.add(value)
    for (const [k, v] of Object.entries(value)) {
      walk(v, `${path}.${k}`)
    }
  }
  walk(config, label)
}

// Source runs (tests, --experimental-strip-types) use the .ts entry; the
// bundles (dist/index.js, dist/index.cjs via tsup's import.meta shim,
// dist/cli.js) sit next to dist/subagent-worker.js.
export const subagentWorkerUrl = (): URL => {
  const here = import.meta.url
  return new URL(here.endsWith('.ts') ? './subagent-worker.ts' : './subagent-worker.js', here)
}

// The worker's node flags. By default (undefined) a worker inherits the
// parent's options itself - notably --experimental-strip-types for source runs
// - and Node drops the per-process ones a worker can't take; passing
// process.execArgv explicitly instead fails on Node 24 under `node --test`
// ("Initiated Worker with invalid execArgv flags: --stack-trace-limit…").
// Only when the parent's flags describe ITS entry point (-e / -p /
// --input-type would make the worker misread its own file) is an explicit,
// filtered list needed.
export const workerExecArgv = (
  argv: readonly string[] = process.execArgv,
): string[] | undefined => {
  const entryPoint = argv.some(
    (a) =>
      ['-e', '--eval', '-p', '--print', '--input-type'].includes(a) ||
      /^--(input-type|eval|print)=/.test(a),
  )
  if (!entryPoint) {
    return undefined
  }
  const out: string[] = []
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (['-e', '--eval', '-p', '--print', '--input-type'].includes(a)) {
      i++
      continue
    }
    if (/^--(input-type|eval|print)=/.test(a)) {
      continue
    }
    out.push(a)
  }
  return out
}

const createSemaphore = (max: number) => {
  let active = 0
  const queue: (() => void)[] = []
  return {
    acquire: (signal?: AbortSignal): Promise<void> =>
      new Promise<void>((resolve, reject) => {
        if (signal?.aborted) {
          reject(signal.reason ?? new DOMException('Aborted', 'AbortError'))
          return
        }
        const grant = (): void => {
          signal?.removeEventListener('abort', onAbort)
          active++
          resolve()
        }
        function onAbort(): void {
          const i = queue.indexOf(grant)
          if (i >= 0) {
            queue.splice(i, 1)
          }
          reject(signal?.reason ?? new DOMException('Aborted', 'AbortError'))
        }
        if (active < max) {
          grant()
          return
        }
        signal?.addEventListener('abort', onAbort, { once: true })
        queue.push(grant)
      }),
    release: (): void => {
      active--
      queue.shift()?.()
    },
  }
}

// Run a host tool for a proxied call; the output is made cloneable.
const runHostTool = async (
  host: Tool | undefined,
  name: string,
  input: unknown,
  callId: string,
  signal: AbortSignal,
): Promise<{ ok: boolean; output: unknown }> => {
  if (!host?.execute) {
    return { ok: false, output: `Unknown proxied tool "${name}"` }
  }
  try {
    const options = {
      toolCallId: callId,
      messages: [],
      abortSignal: signal,
      context: {},
    } as unknown as ToolExecutionOptions<unknown>
    let output = (host.execute as (i: unknown, o: unknown) => unknown)(input, options)
    if (output && typeof (output as AsyncIterable<unknown>)[Symbol.asyncIterator] === 'function') {
      let last: unknown
      for await (const v of output as AsyncIterable<unknown>) {
        last = v
      }
      output = last
    }
    return { ok: true, output: jsonSafe(await output) }
  } catch (err) {
    return { ok: false, output: errorMessage(err) }
  }
}

const describeTools = (tools: ToolSet): IProxiedToolDescriptor[] =>
  Object.entries(tools).map(([name, t]) => ({
    name,
    description: typeof t.description === 'string' ? t.description : '',
    inputSchema: asSchema(t.inputSchema).jsonSchema,
    ...(isReadOnlyTool(t) ? { readOnly: true } : {}),
  }))

interface IChildOutcome {
  text: string
  usage: IUsage
}

const runInProcess = async (
  opts: ISubagentToolOptions,
  task: string,
  signal: AbortSignal,
  onEvent: EventHandler,
): Promise<IChildOutcome> => {
  const tools = { ...(opts.config.tools ?? {}), ...(opts.tools ?? {}) }
  const child = await createAgent(
    { ...opts.config, ...(Object.keys(tools).length ? { tools } : {}) },
    onEvent,
  )
  try {
    const r = await child.run({ input: task, signal })
    return { text: r.text, usage: r.usage }
  } finally {
    await child.close({ timeoutMs: 5_000 }).catch(() => {})
  }
}

const runInWorker = (
  opts: ISubagentToolOptions,
  task: string,
  signal: AbortSignal,
  onEvent: EventHandler,
): Promise<IChildOutcome> =>
  new Promise<IChildOutcome>((resolve, reject) => {
    const hostTools = opts.tools ?? {}
    let settled = false
    let worker: Worker
    try {
      const execArgv = workerExecArgv()
      worker = new Worker(subagentWorkerUrl(), {
        workerData: { subagent: opts.name },
        ...(execArgv ? { execArgv } : {}),
      })
    } catch (err) {
      reject(err)
      return
    }
    const finish = (fn: () => void): void => {
      if (settled) {
        return
      }
      settled = true
      signal.removeEventListener('abort', onAbort)
      fn()
      void worker.terminate().catch(() => {})
    }
    function onAbort(): void {
      worker.postMessage({ type: 'abort' } satisfies ParentToWorkerMessage)
      // Give the child a moment to unwind cleanly, then cut it off.
      const t = setTimeout(
        () => finish(() => reject(signal.reason ?? new DOMException('Aborted', 'AbortError'))),
        1_000,
      )
      t.unref?.()
    }
    // Messages arrive outside of the tool call's async context; bind the
    // handler so proxied host tools still see the parent run (runId,
    // sandbox, approval events).
    const onMessage = AsyncResource.bind((msg: WorkerToParentMessage) => {
      switch (msg.type) {
        case 'event':
          onEvent(msg.event)
          break
        case 'tool-call':
          void runHostTool(hostTools[msg.name], msg.name, msg.input, msg.callId, signal).then(
            (r) => {
              if (!settled) {
                worker.postMessage({
                  type: 'tool-result',
                  callId: msg.callId,
                  ok: r.ok,
                  output: r.output,
                } satisfies ParentToWorkerMessage)
              }
            },
          )
          break
        case 'done':
          finish(() => resolve({ text: msg.text, usage: msg.usage }))
          break
        case 'error':
          finish(() =>
            reject(
              signal.aborted
                ? (signal.reason ?? new DOMException('Aborted', 'AbortError'))
                : new Error(msg.error),
            ),
          )
          break
      }
    })
    worker.on('message', onMessage)
    worker.on('error', (err) => finish(() => reject(err)))
    worker.on('exit', (code) =>
      finish(() => reject(new Error(`subagent worker exited with code ${code} before finishing`))),
    )
    if (signal.aborted) {
      onAbort()
      return
    }
    signal.addEventListener('abort', onAbort, { once: true })
    worker.postMessage({
      type: 'run',
      task,
      config: toCloneable(opts.config),
      proxied: describeTools(hostTools),
    } satisfies ParentToWorkerMessage)
  })

/**
 * Expose a whole agent as ONE tool of a parent agent: input `{ task }`,
 * output the child's final text. Calls in one model step run in parallel
 * (bounded by maxConcurrent); the parent's abort aborts the child; child
 * usage is emitted on the parent as `usage` (phase 'subagent') so it counts
 * against the parent's limits; child events arrive as `subagent.event`.
 */
export const createSubagentTool = (opts: ISubagentToolOptions): Tool => {
  const isolation: SubagentIsolation = opts.isolation ?? 'worker'
  if (!opts.name || typeof opts.name !== 'string') {
    throw new Error('createSubagentTool: name is required')
  }
  if (isolation === 'worker') {
    assertWorkerSafeConfig(opts.config, `subagent "${opts.name}": config`)
  }
  const outputMaxChars = opts.outputMaxChars ?? DEFAULT_OUTPUT_MAX_CHARS
  const sem = createSemaphore(Math.max(1, opts.maxConcurrent ?? DEFAULT_MAX_CONCURRENT))

  const subagent = tool({
    description: opts.description,
    inputSchema: z.object({
      task: z
        .string()
        .describe('A complete, self-contained task for the subagent, with all context it needs'),
    }),
    execute: async ({ task }, { abortSignal }) => {
      const store = runContext.getStore()
      const emit: EventHandler = store?.emit ?? (() => {})
      const id = randomUUID()
      const name = opts.name
      await sem.acquire(abortSignal)
      const ac = new AbortController()
      const onParentAbort = (): void => ac.abort(abortSignal?.reason)
      abortSignal?.addEventListener('abort', onParentAbort, { once: true })
      if (abortSignal?.aborted) {
        onParentAbort()
      }
      let timedOut = false
      const timer =
        typeof opts.timeoutMs === 'number' && opts.timeoutMs > 0
          ? setTimeout(() => {
              timedOut = true
              ac.abort(new Error(`subagent "${name}" timed out after ${opts.timeoutMs}ms`))
            }, opts.timeoutMs)
          : undefined
      let childUsage: IUsage = emptyUsage()
      const onChildEvent: EventHandler = (event) => {
        if (event.type === 'usage') {
          // Counted on the parent as it happens, so the parent's limits
          // see a long-running child.
          const usage = normalizeUsage(event.usage)
          emit({ type: 'usage', phase: 'subagent', usage })
        }
        emit({ type: 'subagent.event', id, name, event: slimEvent(event) })
      }
      try {
        emit({ type: 'subagent.start', id, name, task })
        const out =
          isolation === 'worker'
            ? await runInWorker(opts, task, ac.signal, onChildEvent)
            : await runInProcess(opts, task, ac.signal, onChildEvent)
        childUsage = normalizeUsage(out.usage)
        const text = clipText(out.text, outputMaxChars)
        emit({ type: 'subagent.complete', id, name, text, usage: childUsage })
        return text
      } catch (err) {
        const message = timedOut
          ? `subagent "${name}" timed out after ${opts.timeoutMs}ms`
          : errorMessage(err)
        emit({ type: 'subagent.error', id, name, error: message })
        if (timedOut) {
          throw new Error(message)
        }
        throw err
      } finally {
        if (timer) {
          clearTimeout(timer)
        }
        abortSignal?.removeEventListener('abort', onParentAbort)
        sem.release()
      }
    },
  })
  return markReadOnly(subagent, opts.readOnly === true)
}
