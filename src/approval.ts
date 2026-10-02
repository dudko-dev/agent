import { randomUUID } from 'node:crypto'
import { runContext } from './context.ts'
import type {
  EventHandler,
  IToolApprovalConfig,
  IToolApprovalRequest,
  ToolApprovalDecision,
  ToolApprovalMode,
  ToolPermission,
} from './types.ts'

const MODES: ReadonlySet<string> = new Set<ToolApprovalMode>([
  'autopilot',
  'ask-writes',
  'ask-all',
  'read-only',
])

export const isToolApprovalMode = (v: unknown): v is ToolApprovalMode =>
  typeof v === 'string' && MODES.has(v)

/**
 * Thrown from inside a tool's execute when the call was not approved. The AI
 * SDK records it as a failed tool call (`ok: false`), so the replanner sees
 * it; `toJSON` keeps the message when a trace is serialised.
 */
export class ToolDeniedError extends Error {
  readonly reason?: string

  constructor(reason?: string) {
    super(
      `Tool call denied by the user${reason ? `: ${reason}` : ''}. Do not retry it; continue without it, or report what is blocked.`,
    )
    this.name = 'ToolDeniedError'
    this.reason = reason
  }

  toJSON(): string {
    return this.message
  }
}

// Read-only metadata on a tool object. MCP tools get it from
// annotations.readOnlyHint; native tools opt in with markReadOnly(tool).
export const markReadOnly = <T extends object>(tool: T, readOnly = true): T => {
  ;(tool as { readOnly?: boolean }).readOnly = readOnly
  return tool
}

export const isReadOnlyTool = (tool: unknown): boolean =>
  Boolean(tool) && typeof tool === 'object' && (tool as { readOnly?: unknown }).readOnly === true

const globCache = new Map<string, RegExp>()
const globToRegExp = (glob: string): RegExp => {
  let re = globCache.get(glob)
  if (!re) {
    const body = glob
      .split('*')
      .map((part) => part.replace(/[.+?^${}()|[\]\\]/g, '\\$&'))
      .join('.*')
    re = new RegExp(`^${body}$`)
    globCache.set(glob, re)
  }
  return re
}

/**
 * The most specific rule matching `name`: an exact key wins, then the
 * longest matching '*' glob (ties: the first declared). Pure.
 */
export const matchToolRule = (
  rules: Record<string, ToolPermission> | undefined,
  name: string,
): { pattern: string; permission: ToolPermission } | undefined => {
  if (!rules) {
    return undefined
  }
  if (Object.hasOwn(rules, name) && !name.includes('*')) {
    return { pattern: name, permission: rules[name] }
  }
  let best: { pattern: string; permission: ToolPermission } | undefined
  for (const [pattern, permission] of Object.entries(rules)) {
    if (!pattern.includes('*')) {
      continue
    }
    if (globToRegExp(pattern).test(name) && (!best || pattern.length > best.pattern.length)) {
      best = { pattern, permission }
    }
  }
  return best
}

export interface IToolDecisionInput {
  name: string
  readOnly: boolean
  mode: ToolApprovalMode
  rules?: Record<string, ToolPermission>
  remembered?: ReadonlySet<string>
  // Built-in tools (load_skill, read_skill_file, find_tools) are always allowed.
  builtIn?: boolean
}

export interface IToolDecision {
  permission: ToolPermission
  source: 'builtin' | 'remembered' | 'rule' | 'mode'
  // The matched rule pattern (source 'rule').
  rule?: string
}

/**
 * Decide one call. Pure. Order: built-in -> remembered "always allow" ->
 * most specific rule -> mode default (autopilot: allow; read-only: allow if
 * readOnly else deny; ask-writes: allow if readOnly else ask; ask-all: ask).
 */
export const decideToolPermission = (input: IToolDecisionInput): IToolDecision => {
  if (input.builtIn) {
    return { permission: 'allow', source: 'builtin' }
  }
  if (input.remembered?.has(input.name)) {
    return { permission: 'allow', source: 'remembered' }
  }
  const rule = matchToolRule(input.rules, input.name)
  if (rule) {
    return { permission: rule.permission, source: 'rule', rule: rule.pattern }
  }
  switch (input.mode) {
    case 'autopilot':
      return { permission: 'allow', source: 'mode' }
    case 'read-only':
      return { permission: input.readOnly ? 'allow' : 'deny', source: 'mode' }
    case 'ask-writes':
      return { permission: input.readOnly ? 'allow' : 'ask', source: 'mode' }
    case 'ask-all':
      return { permission: 'ask', source: 'mode' }
  }
}

export interface IApprovalGateOptions {
  readOnly: boolean
  builtIn?: boolean
  signal?: AbortSignal
}

export interface IApprovalController {
  getMode: () => ToolApprovalMode
  setMode: (mode: ToolApprovalMode) => void
  // Tools approved with remember: true (agent-instance lifetime).
  remembered: Set<string>
  // Resolves when the call may run; throws ToolDeniedError otherwise.
  gate: (name: string, input: unknown, opts: IApprovalGateOptions) => Promise<void>
}

const normalizeDecision = (
  d: ToolApprovalDecision | undefined,
): { approved: boolean; reason?: string; remember?: boolean } =>
  typeof d === 'boolean'
    ? { approved: d }
    : d && typeof d === 'object'
      ? { approved: d.approved === true, reason: d.reason, remember: d.remember }
      : { approved: false, reason: 'invalid approval decision' }

class ApprovalTimeout extends Error {}

const awaitDecision = (
  pending: Promise<ToolApprovalDecision>,
  timeoutMs: number | undefined,
  signal: AbortSignal | undefined,
): Promise<ToolApprovalDecision> =>
  new Promise((resolve, reject) => {
    let timer: ReturnType<typeof setTimeout> | undefined
    const done = (): void => {
      if (timer) {
        clearTimeout(timer)
      }
      signal?.removeEventListener('abort', onAbort)
    }
    function onAbort(): void {
      done()
      reject(signal?.reason ?? new DOMException('Aborted', 'AbortError'))
    }
    if (signal?.aborted) {
      onAbort()
      return
    }
    signal?.addEventListener('abort', onAbort, { once: true })
    if (typeof timeoutMs === 'number' && timeoutMs > 0) {
      timer = setTimeout(() => {
        done()
        reject(new ApprovalTimeout())
      }, timeoutMs)
    }
    pending.then(
      (v) => {
        done()
        resolve(v)
      },
      (err: unknown) => {
        done()
        reject(err)
      },
    )
  })

/**
 * One controller per agent instance. The gate runs INSIDE each tool's
 * execute, so it covers native and MCP tools alike; it reads the run's
 * emit / current step / runId from the AsyncLocalStorage run context.
 */
export const createApprovalController = (
  config: IToolApprovalConfig | undefined,
  deps: {
    // Applied to the input shown in the request (idempotent inputSanitizer).
    sanitize?: (name: string, input: unknown) => Promise<unknown>
    // Used when a tool is called outside of a run.
    fallbackEmit?: EventHandler
  } = {},
): IApprovalController => {
  let mode: ToolApprovalMode = config?.mode ?? 'autopilot'
  if (!isToolApprovalMode(mode)) {
    throw new Error(
      `toolApproval.mode must be ${[...MODES].join(' | ')}, got: ${JSON.stringify(mode)}`,
    )
  }
  const remembered = new Set<string>()

  const gate = async (name: string, input: unknown, opts: IApprovalGateOptions): Promise<void> => {
    const decision = decideToolPermission({
      name,
      readOnly: opts.readOnly,
      mode,
      rules: config?.rules,
      remembered,
      builtIn: opts.builtIn,
    })
    if (decision.permission === 'allow') {
      return
    }
    const store = runContext.getStore()
    const emit: EventHandler = store?.emit ?? deps.fallbackEmit ?? (() => {})
    const id = randomUUID()
    const deny = (reason: string, automatic: boolean): never => {
      emit({ type: 'tool.approval-resolved', id, name, approved: false, reason, automatic })
      throw new ToolDeniedError(reason)
    }
    if (decision.permission === 'deny') {
      deny(
        decision.source === 'rule'
          ? `denied by rule "${decision.rule}"`
          : `"${mode}" mode allows read-only tools only`,
        true,
      )
    }
    const onRequest = config?.onRequest
    if (!onRequest) {
      deny('no approval handler configured', true)
      return
    }
    const shown = deps.sanitize ? await deps.sanitize(name, input) : input
    const step = store?.currentStep
    emit({
      type: 'tool.approval-requested',
      id,
      name,
      input: shown,
      readOnly: opts.readOnly,
      ...(step ? { step } : {}),
    })
    const request: IToolApprovalRequest = {
      id,
      toolName: name,
      input: shown,
      readOnly: opts.readOnly,
      ...(step ? { step } : {}),
      ...(store?.runId ? { runId: store.runId } : {}),
    }
    let raw: ToolApprovalDecision
    try {
      raw = await awaitDecision(
        Promise.resolve().then(() => onRequest(request)),
        config?.timeoutMs,
        opts.signal,
      )
    } catch (err) {
      if (err instanceof ApprovalTimeout) {
        deny(`no decision within ${config?.timeoutMs}ms`, true)
      }
      if (opts.signal?.aborted) {
        emit({
          type: 'tool.approval-resolved',
          id,
          name,
          approved: false,
          reason: 'aborted',
          automatic: true,
        })
        throw err
      }
      deny(`approval handler failed: ${(err as Error)?.message ?? String(err)}`, true)
      return
    }
    const d = normalizeDecision(raw)
    if (d.approved && d.remember) {
      remembered.add(name)
    }
    emit({
      type: 'tool.approval-resolved',
      id,
      name,
      approved: d.approved,
      ...(d.reason ? { reason: d.reason } : {}),
      automatic: false,
    })
    if (!d.approved) {
      throw new ToolDeniedError(d.reason)
    }
  }

  return {
    getMode: () => mode,
    setMode: (next) => {
      if (!isToolApprovalMode(next)) {
        throw new Error(
          `tool approval mode must be ${[...MODES].join(' | ')}, got: ${JSON.stringify(next)}`,
        )
      }
      mode = next
    },
    remembered,
    gate,
  }
}
