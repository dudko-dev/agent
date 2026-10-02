import assert from 'node:assert/strict'
import test from 'node:test'
import { tool, type ModelMessage } from 'ai'
import { z } from 'zod'
import {
  createAgent,
  createToolResultClearer,
  withRollingBreakpoint,
  type AgentEvent,
  type IAgentConfig,
} from '../src/index.ts'
import {
  startLocalOpenAI,
  systemOf,
  toolNames,
  toolResults,
  type IChatRequest,
  type Script,
} from './helpers/openai-server.ts'

// The token-saving mechanics shared with the browser sibling: a rolling cache
// breakpoint in the tool loop, clearing stale tool results, a sorted tool list.

const BREAKPOINT = { anthropic: { cacheControl: { type: 'ephemeral' } } }

test('withRollingBreakpoint: only the newest message carries it; earlier ones lose theirs', () => {
  const msgs = [
    { role: 'user', content: 'a' },
    { role: 'assistant', content: 'b', providerOptions: { openai: { x: 1 } } },
  ]
  const out = withRollingBreakpoint(msgs, { enabled: true, ttl: '1h' })
  assert.equal(out[0].providerOptions, undefined)
  assert.deepEqual(out[1].providerOptions, {
    openai: { x: 1 },
    anthropic: { cacheControl: { type: 'ephemeral', ttl: '1h' } },
  })
  const next = withRollingBreakpoint([...out, { role: 'user', content: 'c' }], { enabled: true })
  assert.deepEqual(next[1].providerOptions, { openai: { x: 1 } })
  assert.deepEqual(next[2].providerOptions, BREAKPOINT)
  assert.equal(withRollingBreakpoint(msgs, { enabled: false }), msgs)
})

test('createToolResultClearer: oldest results past the trigger become stubs, sticky, newest kept', () => {
  const infos: unknown[] = []
  const clear = createToolResultClearer({ triggerTokens: 30, keep: 1 }, (i) => infos.push(i))
  const result = (id: string, value: string): ModelMessage => ({
    role: 'tool',
    content: [
      { type: 'tool-result', toolCallId: id, toolName: 'read', output: { type: 'text', value } },
    ],
  })
  const valueOf = (m: ModelMessage) =>
    (m.content as { output: { value: string } }[])[0].output.value
  const first: ModelMessage[] = [{ role: 'user', content: 'go' }, result('a', 'small')]
  assert.equal(clear(first), first)
  const big = 'x'.repeat(200)
  const edited = clear([...first, result('b', big), result('c', big)])
  assert.match(valueOf(edited[1]), /read result cleared/)
  assert.match(valueOf(edited[2]), /read result cleared/)
  assert.equal(valueOf(edited[3]), big)
  assert.equal(infos.length, 1)
  assert.match(valueOf(clear(first)[1]), /cleared/) // sticky
})

const isPlanner = (req: IChatRequest) => systemOf(req).includes('You are the Planner')
const isSynth = (req: IChatRequest) => systemOf(req).includes('You are the Synthesizer')

const config = (baseURL: string, extra: Partial<IAgentConfig>): IAgentConfig => ({
  clientName: 'token-test',
  providerType: 'openai-compatible',
  baseURL,
  apiKey: 'not-a-real-key',
  model: 'scripted',
  mcpServers: {},
  maxIterations: 3,
  maxStepsPerTask: 6,
  logLevel: 'none',
  ...extra,
})

test('tool loop: stale results are cleared on the wire, reported, and tools go in name order', async () => {
  const big = 'y'.repeat(4000)
  const executorRequests: IChatRequest[] = []
  const script: Script = (req) => {
    if (isPlanner(req)) {
      return {
        text: JSON.stringify({
          thought: 'read',
          steps: [{ id: 's1', description: 'Read three pages', expectedOutcome: 'read' }],
        }),
      }
    }
    if (isSynth(req)) return { text: 'Read them all.' }
    executorRequests.push(req)
    const n = toolResults(req).length
    return n < 3 ? { toolCalls: [{ name: 'page', args: { n } }] } : { text: 'Read three pages.' }
  }
  const llm = await startLocalOpenAI(script)
  const events: AgentEvent[] = []
  const agent = await createAgent(
    config(llm.baseURL, {
      compaction: { clearToolResultsAfterTokens: 1200, keepToolResults: 1 },
      tools: {
        zeta: tool({ description: 'z', inputSchema: z.object({}), execute: async () => 'z' }),
        page: tool({
          description: 'Read a page',
          inputSchema: z.object({ n: z.number() }),
          execute: async () => big,
        }),
      },
    }),
  )
  try {
    await agent.run({ input: 'read', onEvent: (e: AgentEvent) => events.push(e) })
    const last = executorRequests.at(-1)!
    const results = toolResults(last)
    assert.equal(results.length, 3)
    assert.match(results[0], /page result cleared to save context/)
    assert.match(results[1], /page result cleared to save context/)

    assert.ok(results[2].includes(big))
    assert.ok(
      events.some((e) => e.type === 'context.compacted' && e.scope === 'tool-results'),
      'the clearing is reported',
    )
    const names = toolNames(executorRequests[0])
    assert.deepEqual(names, [...names].sort())
  } finally {
    await agent.close()
    await llm.close()
  }
})
