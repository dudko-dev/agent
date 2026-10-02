import assert from 'node:assert/strict'
import test from 'node:test'
import { checkLimits, limitsStopCondition, resolveLimits, sumStepUsage } from '../src/limits.ts'
import { addUsage, normalizeUsage } from '../src/utils.ts'

const usage = (input: number, output: number, reasoning = 0) => ({
  inputTokens: input,
  outputTokens: output,
  totalTokens: input + output,
  reasoningTokens: reasoning,
})

test('checkLimits: no limits, no breach', () => {
  assert.equal(checkLimits(usage(1e9, 1e9), undefined), undefined)
  assert.equal(checkLimits(usage(1e9, 1e9), {}), undefined)
})

test('checkLimits reports the first cap reached (>=) in input/output/reasoning/total order', () => {
  assert.deepEqual(checkLimits(usage(100, 5), { maxInputTokens: 100 }), {
    kind: 'input',
    tokens: 100,
    cap: 100,
  })
  assert.equal(checkLimits(usage(99, 5), { maxInputTokens: 100 }), undefined)
  assert.deepEqual(checkLimits(usage(1, 50), { maxOutputTokens: 40 }), {
    kind: 'output',
    tokens: 50,
    cap: 40,
  })
  assert.deepEqual(checkLimits(usage(1, 50, 30), { maxReasoningTokens: 30 }), {
    kind: 'reasoning',
    tokens: 30,
    cap: 30,
  })
  assert.deepEqual(checkLimits(usage(10, 10), { maxTotalTokens: 20, maxInputTokens: 1_000 }), {
    kind: 'total',
    tokens: 20,
    cap: 20,
  })
  // Input is checked before total.
  assert.equal(
    checkLimits(usage(500, 500), { maxInputTokens: 100, maxTotalTokens: 100 })?.kind,
    'input',
  )
})

test('checkLimits treats 0 and negative caps as "no cap"', () => {
  assert.equal(checkLimits(usage(10, 10), { maxTotalTokens: 0, maxInputTokens: -1 }), undefined)
})

test('resolveLimits folds in the legacy maxTotalTokens; limits.maxTotalTokens wins', () => {
  assert.deepEqual(resolveLimits({ maxTotalTokens: 500 }), { maxTotalTokens: 500 })
  assert.deepEqual(resolveLimits({ maxTotalTokens: 500, limits: { maxTotalTokens: 100 } }), {
    maxTotalTokens: 100,
  })
  assert.deepEqual(resolveLimits({ limits: { maxInputTokens: 7 } }), { maxInputTokens: 7 })
})

test('normalizeUsage fills every detail from the AI SDK shape', () => {
  assert.deepEqual(
    normalizeUsage({
      inputTokens: 100,
      outputTokens: 40,
      totalTokens: 140,
      inputTokenDetails: { cacheReadTokens: 60, cacheWriteTokens: 5 },
      outputTokenDetails: { reasoningTokens: 25 },
    }),
    {
      inputTokens: 100,
      outputTokens: 40,
      totalTokens: 140,
      reasoningTokens: 25,
      cachedInputTokens: 60,
      cacheWriteTokens: 5,
    },
  )
  // Missing everything -> zeros, never NaN; total derived when absent.
  assert.deepEqual(normalizeUsage(undefined).totalTokens, 0)
  assert.equal(normalizeUsage({ inputTokens: 3, outputTokens: 4 }).totalTokens, 7)
})

test('addUsage sums every field, treating missing details as 0', () => {
  assert.deepEqual(addUsage(usage(1, 2), { inputTokens: 3, outputTokens: 4, totalTokens: 7 }), {
    inputTokens: 4,
    outputTokens: 6,
    totalTokens: 10,
    reasoningTokens: 0,
    cachedInputTokens: 0,
    cacheWriteTokens: 0,
  })
})

test('limitsStopCondition sums the run so far + the steps of the current call', async () => {
  const stops: string[] = []
  const stop = limitsStopCondition(
    () => usage(10, 10),
    { maxTotalTokens: 50 },
    (b) => stops.push(b.kind),
  )
  const step = { usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 } }
  assert.equal(await stop({ steps: [step] as never }), false) // 20 + 15
  assert.equal(await stop({ steps: [step, step] as never }), true) // 20 + 30
  assert.deepEqual(stops, ['total'])
  assert.equal(sumStepUsage([step, step]).totalTokens, 30)
})
