// End-to-end smoke test for the AI SDK v6 wire format. The four agent
// stages drive `streamText` (executor + synthesizer), `streamObject`
// (planner), and `generateObject` (replanner). This file plugs a
// MockLanguageModelV3 into each of those entry points with the exact
// schemas the agent uses (PlanSchema / DecisionSchema), so a v6 stream-
// chunk-format regression or a schema-validation drift fails here at
// `npm test` time - long before any real provider call is made.

import assert from 'node:assert/strict'
import test from 'node:test'
import { generateObject, streamObject, streamText, type LanguageModel } from 'ai'
import { MockLanguageModelV3 } from 'ai/test'
import { PlanSchema } from '../src/planner.ts'
import { DecisionSchema } from '../src/replanner.ts'

// V3 stream-part shapes: finishReason is { unified, raw }, usage is the
// nested-token-buckets struct. Emitting v2-shaped values here would slip
// through `streamText` (which is lenient about malformed usage) but trip
// `streamObject` deep in `chunk.finishReason.unified` access and silently
// hang the test - so we build them properly once.
const v3FinishReason = { unified: 'stop' as const, raw: undefined }
const v3Usage = (input: number, output: number) => ({
  inputTokens: { total: input, noCache: input, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: output, text: output, reasoning: 0 },
})

// Helper: build a streaming model that emits a single text run with the
// given chunks then a `finish` part. Mirrors what a real provider streams
// for a plain text response.
const streamingModel = (chunks: string[]): LanguageModel =>
  new MockLanguageModelV3({
    doStream: async () => ({
      stream: new ReadableStream({
        start(controller) {
          controller.enqueue({ type: 'stream-start', warnings: [] })
          controller.enqueue({ type: 'text-start', id: '0' })
          for (const delta of chunks) {
            controller.enqueue({ type: 'text-delta', id: '0', delta })
          }
          controller.enqueue({ type: 'text-end', id: '0' })
          controller.enqueue({
            type: 'finish',
            finishReason: v3FinishReason,
            usage: v3Usage(1, chunks.length),
          })
          controller.close()
        },
      }),
    }),
  })

// Helper: build a non-streaming model that returns a single text response
// from doGenerate (the path used by generateObject).
const generatingModel = (text: string): LanguageModel =>
  new MockLanguageModelV3({
    doGenerate: async () => ({
      content: [{ type: 'text', text }],
      finishReason: v3FinishReason,
      usage: v3Usage(1, text.length),
      warnings: [],
    }),
  })

test('v6 streamText round-trips text deltas from a v3 mock model', async () => {
  const model = streamingModel(['hello ', 'v6 ', 'world'])
  const result = streamText({ model, prompt: 'greet' })
  let text = ''
  for await (const delta of result.textStream) {
    text += delta
  }
  assert.equal(text, 'hello v6 world')
})

test('v6 streamObject parses the planner schema from a streamed JSON model output', async () => {
  // Stream the JSON in two chunks to make sure the SDK reassembles it.
  const planJson = JSON.stringify({
    thought: 'Just answer directly - no tools needed for this prompt.',
    steps: [
      {
        id: 's1',
        description: 'Produce the final answer',
        expectedOutcome: 'A short text reply',
      },
    ],
  })
  const model = streamingModel([planJson.slice(0, 30), planJson.slice(30)])
  const result = streamObject({ model, schema: PlanSchema, prompt: 'plan it' })
  // streamObject is lazy: nothing happens until something pulls from one of
  // its streams. partialObjectStream is what the planner subscribes to in
  // production, so iterating it here exercises the same path. Without this
  // drain `await result.object` would hang forever waiting for a finish
  // chunk that no consumer ever pulled.
  for await (const _ of result.partialObjectStream) {
    void _
  }
  const obj = await result.object
  assert.equal(obj.steps.length, 1)
  assert.equal(obj.steps[0]!.id, 's1')
  assert.match(obj.thought, /answer directly/)
})

test('v6 generateObject parses the replanner DecisionSchema (finish branch)', async () => {
  const decision = JSON.stringify({ mode: 'finish', reason: 'executor produced the answer' })
  const model = generatingModel(decision)
  const result = await generateObject({ model, schema: DecisionSchema, prompt: 'decide' })
  assert.equal(result.object.mode, 'finish')
  assert.equal(result.object.reason, 'executor produced the answer')
})

test('v6 generateObject parses the replanner DecisionSchema (revise branch with nested PlanSchema)', async () => {
  const decision = JSON.stringify({
    mode: 'revise',
    reason: 'first plan was too optimistic; reduce scope',
    newPlan: {
      thought: 'Tighten the plan',
      steps: [{ id: 's1', description: 'do less', expectedOutcome: 'less is done' }],
    },
  })
  const model = generatingModel(decision)
  const result = await generateObject({ model, schema: DecisionSchema, prompt: 'decide' })
  assert.equal(result.object.mode, 'revise')
  if (result.object.mode === 'revise') {
    assert.equal(result.object.newPlan.steps.length, 1)
  }
})
