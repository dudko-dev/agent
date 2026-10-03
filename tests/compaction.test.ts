import assert from 'node:assert/strict'
import test from 'node:test'
import { tool, type LanguageModel, type Tool } from 'ai'
import { MockLanguageModelV3 } from 'ai/test'
import { z } from 'zod'
import {
  compactHistory,
  estimateTokens,
  isSummaryTurn,
  resolveCompaction,
  SUMMARY_PREFIX,
  summarizeTrace,
  truncateToolModelOutput,
  withToolOutputLimit,
} from '../src/compaction.ts'
import { renderHistory, renderTrace, renderTraceSteps } from '../src/prompts.ts'
import type { IConversationTurn, IStepResult } from '../src/types.ts'

const v3Usage = (input: number, output: number) => ({
  inputTokens: { total: input, noCache: input, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: output, text: output, reasoning: 0 },
})

// A generate-only mock that records the prompts it was given.
const summarizer = (text: string) => {
  const prompts: string[] = []
  const model = new MockLanguageModelV3({
    doGenerate: async (options) => {
      prompts.push(JSON.stringify(options.prompt))
      return {
        content: [{ type: 'text', text }],
        finishReason: { unified: 'stop', raw: undefined },
        usage: v3Usage(100, 20),
        warnings: [],
      }
    },
  })
  return { model: model as LanguageModel, prompts }
}

const failing = (): LanguageModel =>
  new MockLanguageModelV3({
    doGenerate: async () => {
      throw new Error('provider down')
    },
  })

const turns = (n: number, size = 40): IConversationTurn[] =>
  Array.from({ length: n }, (_, i) => ({
    role: i % 2 === 0 ? ('user' as const) : ('assistant' as const),
    content: `turn ${i} ${'x'.repeat(size)}`,
  }))

test('estimateTokens is ceil(chars / 4)', () => {
  assert.equal(estimateTokens(''), 0)
  assert.equal(estimateTokens('abcd'), 1)
  assert.equal(estimateTokens('abcde'), 2)
})

test('resolveCompaction defaults: auto on, 128k window, threshold at 50%', () => {
  assert.deepEqual(resolveCompaction(undefined), {
    auto: true,
    contextWindowTokens: 128_000,
    thresholdTokens: 64_000,
    keepRecentTurns: 4,
    keepRecentSteps: 3,
    summaryMaxTokens: 1024,
    maxToolOutputChars: 20_000,
    clearToolResultsAfterTokens: 32_000,
    keepToolResults: 3,
  })
  const custom = resolveCompaction({
    auto: false,
    contextWindowTokens: 8_000,
    maxToolOutputChars: 0,
    clearToolResultsAfterTokens: 0,
  })
  assert.equal(custom.auto, false)
  assert.equal(custom.thresholdTokens, 4_000)
  assert.equal(custom.maxToolOutputChars, 0)
  assert.equal(custom.clearToolResultsAfterTokens, 0)
})

test('compactHistory: below the threshold the input comes back untouched', async () => {
  const { model, prompts } = summarizer('S')
  const history = turns(10)
  const r = await compactHistory(history, model, { thresholdTokens: 1_000_000 })
  assert.equal(r.compacted, false)
  assert.equal(r.history, history)
  assert.equal(prompts.length, 0, 'no model call below the threshold')
})

test('compactHistory: summarises all but the recent turns into one assistant summary turn', async () => {
  const { model, prompts } = summarizer('They discussed invoices; total was 42.')
  const history = turns(10)
  const frozen = JSON.stringify(history)
  const usages: number[] = []
  const r = await compactHistory(history, model, {
    thresholdTokens: 10,
    keepRecentTurns: 4,
    onUsage: (u) => usages.push(u.totalTokens),
  })
  assert.equal(r.compacted, true)
  assert.equal(r.history.length, 5)
  assert.equal(r.history[0].role, 'assistant')
  assert.ok(r.history[0].content.startsWith(SUMMARY_PREFIX))
  assert.ok(isSummaryTurn(r.history[0]))
  assert.deepEqual(r.history.slice(1), history.slice(6))
  assert.equal(r.summary, 'They discussed invoices; total was 42.')
  assert.ok(r.afterTokens < r.beforeTokens)
  assert.deepEqual(usages, [120])
  assert.equal(JSON.stringify(history), frozen, 'the input array is not mutated')
  assert.ok(prompts[0].includes('turn 0') && !prompts[0].includes('turn 6'))

  // A second pass folds the earlier summary into the new one.
  const again = await compactHistory([...r.history, ...turns(4)], model, {
    force: true,
    keepRecentTurns: 2,
  })
  assert.equal(again.history.filter(isSummaryTurn).length, 1)
})

test('compactHistory: force bypasses the threshold; never throws on failure', async () => {
  const { model } = summarizer('short')
  const forced = await compactHistory(turns(6, 1), model, { force: true, keepRecentTurns: 2 })
  assert.equal(forced.compacted, true)
  const history = turns(6)
  const failed = await compactHistory(history, failing(), { force: true })
  assert.equal(failed.compacted, false)
  assert.equal(failed.history, history)
  // Nothing older than the kept window -> nothing to do.
  const tiny = await compactHistory(turns(3), model, { force: true, keepRecentTurns: 4 })
  assert.equal(tiny.compacted, false)
})

test('renderHistory always keeps a leading summary turn', () => {
  const history: IConversationTurn[] = [
    { role: 'assistant', content: `${SUMMARY_PREFIX}\n${'s'.repeat(3000)}` },
    ...turns(12),
  ]
  const out = renderHistory(history)
  assert.ok(out.startsWith(`assistant: ${SUMMARY_PREFIX}`))
  assert.ok(out.includes('s'.repeat(3000)), 'the summary is not clipped at 1500 chars')
  assert.match(out, /\(4 earlier turns omitted\)/)
})

const stepResult = (i: number): IStepResult => ({
  step: { id: `s${i}`, description: `do ${i}`, expectedOutcome: 'e' },
  summary: `result ${i}`,
  toolCalls: [],
  durationMs: 1,
  blocked: false,
})

test('renderTrace with a summary view renders the summary + the recent steps verbatim', () => {
  const trace = [stepResult(0), stepResult(1), stepResult(2)]
  const out = renderTrace(trace, { summary: 'did 0 and 1', upTo: 2 })
  assert.equal(
    out,
    'Summary of earlier steps (1-2): did 0 and 1\nStep 3: do 2\n  Result: result 2\n  Tool calls:\n    (no tool calls)',
  )
  assert.equal(renderTrace(trace, { upTo: 2 }), renderTrace(trace), 'no summary, no view')
})

test('summarizeTrace folds steps (and an earlier summary) into one summary; undefined on failure', async () => {
  const { model, prompts } = summarizer('steps 1-2 found X')
  const r = await summarizeTrace([stepResult(1)], 'earlier: found W', model, {
    render: renderTraceSteps,
    offset: 1,
  })
  assert.equal(r?.summary, 'steps 1-2 found X')
  assert.equal(r?.usage.totalTokens, 120)
  assert.ok(prompts[0].includes('earlier: found W'))
  assert.ok(prompts[0].includes('Step 2: do 1'), 'step numbers follow the offset')
  assert.equal(
    await summarizeTrace([stepResult(0)], undefined, failing(), {
      render: renderTraceSteps,
      offset: 0,
    }),
    undefined,
  )
})

test('truncateToolModelOutput clips text, serialised json and content text parts', () => {
  assert.deepEqual(truncateToolModelOutput({ type: 'text', value: 'abcdefghij' }, 4), {
    type: 'text',
    value: 'abcd… [truncated 6 chars]',
  })
  assert.deepEqual(truncateToolModelOutput({ type: 'text', value: 'abc' }, 4), {
    type: 'text',
    value: 'abc',
  })
  const json = truncateToolModelOutput({ type: 'json', value: { rows: [1, 2, 3, 4, 5] } }, 10)
  assert.equal(json.type, 'text')
  assert.equal((json as { value: string }).value, '{"rows":[1… [truncated 10 chars]')
  assert.deepEqual(truncateToolModelOutput({ type: 'json', value: [1] }, 10), {
    type: 'json',
    value: [1],
  })
  const content = truncateToolModelOutput(
    { type: 'content', value: [{ type: 'text', text: 'x'.repeat(20) }] },
    5,
  )
  assert.deepEqual(content, {
    type: 'content',
    value: [{ type: 'text', text: 'xxxxx… [truncated 15 chars]' }],
  })
  // 0 = unlimited; errors pass through.
  assert.deepEqual(truncateToolModelOutput({ type: 'text', value: 'abcdef' }, 0), {
    type: 'text',
    value: 'abcdef',
  })
  assert.deepEqual(truncateToolModelOutput({ type: 'error-text', value: 'x'.repeat(50) }, 5), {
    type: 'error-text',
    value: 'x'.repeat(50),
  })
})

test('withToolOutputLimit: the model sees a clipped result, the raw output is untouched', async () => {
  const big = tool({
    description: 'big',
    inputSchema: z.object({}),
    execute: async () => 'y'.repeat(100),
  })
  const limited = withToolOutputLimit(big, 10)
  const raw = await (limited.execute as (i: unknown, o: unknown) => Promise<string>)({}, {})
  assert.equal(raw.length, 100)
  const seen = await limited.toModelOutput!({ toolCallId: 'c', input: {}, output: raw })
  assert.deepEqual(seen, { type: 'text', value: 'yyyyyyyyyy… [truncated 90 chars]' })

  // An existing toModelOutput runs first, then its value is clipped.
  const custom = withToolOutputLimit(
    tool({
      description: 'custom',
      inputSchema: z.object({}),
      execute: async () => ({ n: 1 }),
      toModelOutput: () => ({ type: 'text', value: 'custom-rendering-that-is-long' }),
    }),
    6,
  )
  assert.deepEqual(await custom.toModelOutput!({ toolCallId: 'c', input: {}, output: { n: 1 } }), {
    type: 'text',
    value: 'custom… [truncated 23 chars]',
  })
  // Objects become json (as the SDK would send them), clipped when long.
  const obj = withToolOutputLimit(big as Tool, 1_000)
  assert.deepEqual(await obj.toModelOutput!({ toolCallId: 'c', input: {}, output: { a: 1 } }), {
    type: 'json',
    value: { a: 1 },
  })
  assert.equal(withToolOutputLimit(big, 0), big, '0 = unlimited, no wrapper')
})
