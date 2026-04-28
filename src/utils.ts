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
