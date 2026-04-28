import assert from 'node:assert/strict'
import test from 'node:test'
import { combineSignals, redactHeaders, withRetry, withTimeout } from '../src/utils.ts'

test('withRetry retries on 5xx and eventually succeeds', async () => {
  let attempts = 0
  const result = await withRetry(
    async () => {
      attempts++
      if (attempts < 3) {
        throw Object.assign(new Error('boom'), { status: 503 })
      }
      return 'ok'
    },
    { maxRetries: 3, baseDelayMs: 0 },
  )
  assert.equal(result, 'ok')
  assert.equal(attempts, 3)
})

test('withRetry retries on 429', async () => {
  let attempts = 0
  await withRetry(
    async () => {
      attempts++
      if (attempts === 1) {
        throw Object.assign(new Error('rate'), { statusCode: 429 })
      }
      return 'ok'
    },
    { maxRetries: 2, baseDelayMs: 0 },
  )
  assert.equal(attempts, 2)
})

test('withRetry rethrows immediately on non-retriable 4xx', async () => {
  let attempts = 0
  await assert.rejects(
    () =>
      withRetry(
        async () => {
          attempts++
          throw Object.assign(new Error('bad'), { status: 400 })
        },
        { maxRetries: 3, baseDelayMs: 0 },
      ),
    /bad/,
  )
  assert.equal(attempts, 1)
})

test('withRetry stops after maxRetries and rethrows last error', async () => {
  let attempts = 0
  await assert.rejects(
    () =>
      withRetry(
        async () => {
          attempts++
          throw Object.assign(new Error('still 503'), { status: 503 })
        },
        { maxRetries: 2, baseDelayMs: 0 },
      ),
    /still 503/,
  )
  assert.equal(attempts, 3)
})

test('withRetry calls onRetry hook with attempt number', async () => {
  const calls: number[] = []
  await withRetry(
    async () => {
      if (calls.length < 2) {
        throw Object.assign(new Error('e'), { status: 500 })
      }
      return 1
    },
    {
      maxRetries: 3,
      baseDelayMs: 0,
      onRetry: (attempt) => calls.push(attempt),
    },
  )
  assert.deepEqual(calls, [1, 2])
})

test('withRetry does not retry AbortError', async () => {
  let attempts = 0
  await assert.rejects(
    () =>
      withRetry(
        async () => {
          attempts++
          throw Object.assign(new Error('aborted'), { name: 'AbortError' })
        },
        { maxRetries: 3, baseDelayMs: 0 },
      ),
    (err: Error) => err.name === 'AbortError',
  )
  assert.equal(attempts, 1)
})

test('withRetry honors a pre-aborted signal', async () => {
  const ac = new AbortController()
  ac.abort()
  await assert.rejects(
    () => withRetry(async () => 'unreachable', { maxRetries: 1, signal: ac.signal }),
    (err: Error) => err.name === 'AbortError',
  )
})

test('withRetry follows error.cause chain', async () => {
  let attempts = 0
  const result = await withRetry(
    async () => {
      attempts++
      if (attempts < 2) {
        const cause = Object.assign(new Error('inner'), { status: 500 })
        throw Object.assign(new Error('outer'), { cause })
      }
      return 'ok'
    },
    { maxRetries: 2, baseDelayMs: 0 },
  )
  assert.equal(result, 'ok')
  assert.equal(attempts, 2)
})

test('redactHeaders masks well-known secret keys, case-insensitive', () => {
  const out = redactHeaders({
    Authorization: 'Bearer abc',
    'X-Api-Key': 'xx',
    'Proxy-Authorization': 'pp',
    Cookie: 'session=1',
    'User-Agent': 'me',
  })
  assert.equal(out!.Authorization, '***redacted***')
  assert.equal(out!['X-Api-Key'], '***redacted***')
  assert.equal(out!['Proxy-Authorization'], '***redacted***')
  assert.equal(out!.Cookie, '***redacted***')
  assert.equal(out!['User-Agent'], 'me')
})

test('redactHeaders passes through undefined', () => {
  assert.equal(redactHeaders(undefined), undefined)
})

test('withTimeout aborts after the configured delay', async () => {
  const signal = withTimeout(undefined, 20)
  assert.equal(signal.aborted, false)
  await new Promise((r) => setTimeout(r, 50))
  assert.equal(signal.aborted, true)
})

test('withTimeout returns input signal when timeoutMs is invalid', () => {
  const ac = new AbortController()
  const out = withTimeout(ac.signal, 0)
  assert.equal(out, ac.signal)
})

test('combineSignals propagates abort from any input', () => {
  const a = new AbortController()
  const b = new AbortController()
  const combined = combineSignals([a.signal, b.signal])
  assert.equal(combined.aborted, false)
  b.abort()
  assert.equal(combined.aborted, true)
})

test('combineSignals returns the lone signal unchanged', () => {
  const a = new AbortController()
  const out = combineSignals([undefined, a.signal])
  assert.equal(out, a.signal)
})
