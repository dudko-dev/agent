import type { IUsage } from './types.ts'

export interface IRetryOptions {
  maxRetries: number
  baseDelayMs?: number
  signal?: AbortSignal
  onRetry?: (attempt: number, err: unknown) => void
}

const isRetriable = (err: unknown, seen: Set<unknown> = new Set()): boolean => {
  if (!err || typeof err !== 'object') {
    return false
  }
  // Cycle guard: error.cause may form a loop (synthetic tests, exotic SDK
  // wrappers). Without this check, recursion below would stack-overflow.
  if (seen.has(err)) {
    return false
  }
  seen.add(err)

  const e = err as { statusCode?: number; status?: number; name?: string; cause?: unknown }
  if (e.name === 'AbortError') {
    return false
  }
  const status = e.statusCode ?? e.status
  if (typeof status === 'number') {
    return status === 429 || status >= 500
  }
  // Network-level errors don't carry a status; fetch usually throws TypeError.
  if (e.name === 'TypeError') {
    return true
  }
  if (e.cause && typeof e.cause === 'object') {
    return isRetriable(e.cause, seen)
  }
  return false
}

export const withRetry = async <T>(fn: () => Promise<T>, opts: IRetryOptions): Promise<T> => {
  const base = opts.baseDelayMs ?? 500
  let lastErr: unknown
  for (let attempt = 0; attempt <= opts.maxRetries; attempt++) {
    if (opts.signal?.aborted) {
      throw new DOMException('Aborted', 'AbortError')
    }
    try {
      return await fn()
    } catch (err) {
      lastErr = err
      if (attempt === opts.maxRetries || !isRetriable(err)) {
        throw err
      }
      opts.onRetry?.(attempt + 1, err)
      const delay = base * 2 ** attempt + Math.random() * 250
      await sleep(delay, opts.signal)
    }
  }
  throw lastErr
}

const sleep = (ms: number, signal?: AbortSignal): Promise<void> =>
  new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new DOMException('Aborted', 'AbortError'))
      return
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    const onAbort = () => {
      clearTimeout(timer)
      reject(new DOMException('Aborted', 'AbortError'))
    }
    signal?.addEventListener('abort', onAbort, { once: true })
  })

export const combineSignals = (signals: (AbortSignal | undefined)[]): AbortSignal => {
  const filtered = signals.filter((s): s is AbortSignal => Boolean(s))
  if (filtered.length === 0) {
    return new AbortController().signal
  }
  if (filtered.length === 1) {
    return filtered[0]
  }
  // AbortSignal.any exists in Node 22+; we are >=22.6 in engines.
  return AbortSignal.any(filtered)
}

export const withTimeout = (signal: AbortSignal | undefined, timeoutMs: number): AbortSignal => {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    return signal ?? new AbortController().signal
  }
  return combineSignals([signal, AbortSignal.timeout(timeoutMs)])
}

const SECRET_HEADER_KEYS = new Set([
  'authorization',
  'proxy-authorization',
  'x-api-key',
  'api-key',
  'cookie',
  'set-cookie',
])

export const redactHeaders = (
  headers: Record<string, string> | undefined,
): Record<string, string> | undefined => {
  if (!headers) {
    return headers
  }
  const out: Record<string, string> = {}
  for (const [k, v] of Object.entries(headers)) {
    out[k] = SECRET_HEADER_KEYS.has(k.toLowerCase()) ? '***redacted***' : v
  }
  return out
}

// A zeroed usage record with every optional detail filled in.
export const emptyUsage = (): Required<IUsage> => ({
  inputTokens: 0,
  outputTokens: 0,
  totalTokens: 0,
  reasoningTokens: 0,
  cachedInputTokens: 0,
  cacheWriteTokens: 0,
})

// The subset of the AI SDK's LanguageModelUsage we read. Every field is
// optional so a provider that reports nothing (or a v6-shaped object) still
// normalises to zeros instead of NaN.
export interface ISdkUsageLike {
  inputTokens?: number
  outputTokens?: number
  totalTokens?: number
  inputTokenDetails?: { cacheReadTokens?: number; cacheWriteTokens?: number }
  outputTokenDetails?: { reasoningTokens?: number }
  // Pre-v6 flat fields, still produced by some wrappers.
  reasoningTokens?: number
  cachedInputTokens?: number
}

const n = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0)

// AI SDK usage -> IUsage with every detail field filled (0 when unknown).
export const normalizeUsage = (usage: ISdkUsageLike | undefined | null): Required<IUsage> => {
  if (!usage) {
    return emptyUsage()
  }
  const inputTokens = n(usage.inputTokens)
  const outputTokens = n(usage.outputTokens)
  return {
    inputTokens,
    outputTokens,
    totalTokens:
      typeof usage.totalTokens === 'number' ? usage.totalTokens : inputTokens + outputTokens,
    reasoningTokens: n(usage.outputTokenDetails?.reasoningTokens ?? usage.reasoningTokens),
    cachedInputTokens: n(usage.inputTokenDetails?.cacheReadTokens ?? usage.cachedInputTokens),
    cacheWriteTokens: n(usage.inputTokenDetails?.cacheWriteTokens),
  }
}

// a + b, field by field (missing optional fields count as 0).
export const addUsage = (a: IUsage, b: IUsage): Required<IUsage> => ({
  inputTokens: a.inputTokens + b.inputTokens,
  outputTokens: a.outputTokens + b.outputTokens,
  totalTokens: a.totalTokens + b.totalTokens,
  reasoningTokens: (a.reasoningTokens ?? 0) + (b.reasoningTokens ?? 0),
  cachedInputTokens: (a.cachedInputTokens ?? 0) + (b.cachedInputTokens ?? 0),
  cacheWriteTokens: (a.cacheWriteTokens ?? 0) + (b.cacheWriteTokens ?? 0),
})

// Add b into a, in place (the run accumulator is shared by reference).
export const accumulateUsage = (into: IUsage, b: IUsage): void => {
  Object.assign(into, addUsage(into, b))
}

// Clip a string to max chars with a "… [truncated N chars]" marker.
export const clipText = (s: string, max: number): string =>
  max > 0 && s.length > max ? `${s.slice(0, max)}… [truncated ${s.length - max} chars]` : s

export const errorMessage = (err: unknown): string =>
  err instanceof Error ? err.message : typeof err === 'string' ? err : JSON.stringify(err)
