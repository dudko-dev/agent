import assert from 'node:assert/strict'
import test from 'node:test'
import { tool } from 'ai'
import { MockLanguageModelV3 } from 'ai/test'
import { z } from 'zod'
import {
  compactHistory,
  DEFAULT_COMPACTION_THRESHOLD_RATIO,
  estimateTokens,
  promptOverheadTokens,
  renderTurns,
  resolveCompaction,
  tailWithinTokens,
  toolDefinitionTokens,
} from '../src/compaction.ts'
import {
  createAgent,
  type AgentEvent,
  type IAgent,
  type IAgentConfig,
  type ISkill,
} from '../src/index.ts'
import {
  startLocalOpenAI,
  systemOf,
  userOf,
  type IChatRequest,
  type ILocalOpenAI,
  type Script,
} from './helpers/openai-server.ts'

// Compaction is judged on the whole context - the fixed prompt (system, tools, skills), the
// history and the trace together - against a share of the window, not on each part alone.

// ── the estimate ─────────────────────────────────────────────────────────────

test('estimateTokens: by kind of text - code, JSON and numbers cost more per character than prose', () => {
  assert.equal(estimateTokens(''), 0)
  const n = 1_000
  const prose = estimateTokens('The committee reviews the budget. '.repeat(n / 34))
  const code = estimateTokens('const x = foo(bar, [1, 2, 3]);\n'.repeat(n / 31))
  const json = estimateTokens('{"id":12,"name":"a","tags":["b"]}'.repeat(n / 33))
  const digits = estimateTokens('1234567890'.repeat(n / 10))
  assert.ok(
    prose < code && code < json && json <= digits * 1.2,
    `${prose} ${code} ${json} ${digits}`,
  )
  // Cyrillic about 2 characters a token, CJK and emoji about 1.
  assert.equal(estimateTokens('ж'.repeat(100)), 55)
  assert.equal(estimateTokens('漢'.repeat(100)), 110)
  assert.equal(estimateTokens('😀'), 3, 'a surrogate pair is two units')
})

test('estimateTokens: never below the old flat "4 characters a token" for ASCII - it leans high on purpose', () => {
  // Calibrated against Claude's tokenizer (see compaction.ts): the flat figure was 0.4-0.7x of the
  // real count for everything but Russian, which would let an 85% threshold overflow the window.
  let seed = 7
  const rand = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff
  const alphabet = 'abcdefghijklmnopqrstuvwxyz ABCDEFGHIJ 0123456789 {}[]()",.:;=<>/\\-_\n\t'
  for (let i = 0; i < 200; i += 1) {
    const len = 1 + Math.floor(rand() * 500)
    const text = Array.from(
      { length: len },
      () => alphabet[Math.floor(rand() * alphabet.length)],
    ).join('')
    assert.ok(estimateTokens(text) >= Math.ceil(len / 4), JSON.stringify(text))
  }
})

test('tailWithinTokens: the newest part that fits, from a line break when there is one', () => {
  const lines = Array.from(
    { length: 50 },
    (_, i) => `line-${String(i).padStart(2, '0')} ${'z'.repeat(92)}`,
  )
  const text = lines.join('\n')
  assert.equal(tailWithinTokens(text, 1_000_000), text, 'fits: untouched')
  const cut = tailWithinTokens(text, 500)
  assert.ok(estimateTokens(cut) <= 500, `${estimateTokens(cut)} tokens`)
  assert.ok(estimateTokens(cut) >= 400, 'and most of the budget is used')
  assert.match(cut, /line-49/)
  assert.doesNotMatch(cut, /line-00/)
  assert.match(cut, /^line-\d\d /, 'it starts at a line, not mid-sentence')
  // Cyrillic is counted at its real weight, so fewer characters fit.
  const ru = tailWithinTokens('ж'.repeat(10_000), 500)
  assert.ok(ru.length <= 1_000 && estimateTokens(ru) <= 500)
  assert.equal(tailWithinTokens('abc', 0), 'abc', 'no budget: untouched')
})

// ── the threshold ────────────────────────────────────────────────────────────

test('threshold: 85% of the window by default; thresholdRatio and thresholdTokens override it', () => {
  assert.equal(DEFAULT_COMPACTION_THRESHOLD_RATIO, 0.85)
  assert.equal(resolveCompaction({}).thresholdTokens, 108_800)
  assert.equal(resolveCompaction({ contextWindowTokens: 10_000 }).thresholdTokens, 8_500)
  assert.equal(
    resolveCompaction({ contextWindowTokens: 10_000, thresholdRatio: 0.9 }).thresholdTokens,
    9_000,
  )
  assert.equal(
    resolveCompaction({ contextWindowTokens: 10_000, thresholdRatio: 0.9, thresholdTokens: 5_000 })
      .thresholdTokens,
    5_000,
    'the absolute number wins',
  )
  for (const bad of [0, -0.5, 1.5, Number.NaN]) {
    assert.equal(
      resolveCompaction({ contextWindowTokens: 10_000, thresholdRatio: bad }).thresholdTokens,
      8_500,
      String(bad),
    )
  }
})

// ── the fixed prompt ─────────────────────────────────────────────────────────

test('promptOverheadTokens: base + system prompt + tool definitions + skills; search caps the tools', async () => {
  const wordy = tool({
    description: 'd'.repeat(10_000),
    inputSchema: z.object({ q: z.string() }),
    execute: async () => 'x',
  })
  const toolTokens = await toolDefinitionTokens({ big: wordy })
  assert.ok(toolTokens > 4_400 && toolTokens < 4_700, String(toolTokens)) // 10 000 letters ~ 4 400
  // Cached per tool object: asking again is the same number.
  assert.equal(await toolDefinitionTokens({ big: wordy }), toolTokens)
  const p = {
    systemPrompt: 's'.repeat(400),
    toolTokens,
    searching: false,
    skillsText: 'k'.repeat(40),
  }
  const sys = estimateTokens(p.systemPrompt)
  const skills = estimateTokens(p.skillsText)
  assert.equal(promptOverheadTokens(p), 1_500 + sys + toolTokens + skills)
  assert.equal(promptOverheadTokens({ ...p, searching: true }), 1_500 + sys + 3_000 + skills)
  assert.equal(
    promptOverheadTokens({ ...p, toolTokens: 500, searching: true }),
    1_500 + sys + 500 + skills,
    'a small catalogue stays small',
  )
})

test('compactHistory: the overhead counts against the threshold; maxInputTokens bounds what is summarised', async () => {
  const seen: string[] = []
  const model = new MockLanguageModelV3({
    doGenerate: async (options) => {
      seen.push(JSON.stringify(options.prompt))
      return {
        content: [{ type: 'text', text: 'S' }],
        finishReason: { unified: 'stop', raw: undefined },
        usage: {
          inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
          outputTokens: { total: 1, text: 1, reasoning: 0 },
        },
        warnings: [],
      }
    },
  })
  const history = Array.from({ length: 8 }, (_, i) => ({
    role: (i % 2 ? 'assistant' : 'user') as 'user' | 'assistant',
    content: `${i}`.repeat(1_000),
  }))
  // Under the threshold on its own...
  const size = estimateTokens(renderTurns(history))
  const alone = await compactHistory(history, model, { thresholdTokens: size + 100 })
  assert.equal(alone.compacted, false)
  // ...over it once the prompt around it is counted.
  const withPrompt = await compactHistory(history, model, {
    thresholdTokens: size + 100,
    overheadTokens: 200,
  })
  assert.equal(withPrompt.compacted, true)
  assert.equal(seen.length, 1)
  // The summariser is shown the NEWEST part that fits.
  await compactHistory(history, model, { force: true, maxInputTokens: 600 })
  assert.ok(seen[1].length < seen[0].length, 'less was shown')
  assert.match(seen[1], /3333/, 'the newest of the older turns is there')
  assert.doesNotMatch(seen[1], /0000000000/, 'the oldest is cut')
})

// ── the whole context decides, in a real run ─────────────────────────────────

type Stage =
  'planner' | 'executor' | 'replanner' | 'synthesizer' | 'compact-history' | 'compact-trace'
const stageOf = (req: IChatRequest): Stage => {
  const system = systemOf(req)
  if (system.includes('You are the Planner')) return 'planner'
  if (system.includes('You are the Replanner')) return 'replanner'
  if (system.includes('You are the Synthesizer')) return 'synthesizer'
  if (system.includes('You compress conversation history')) return 'compact-history'
  if (system.includes('You compress the execution trace')) return 'compact-trace'
  return 'executor'
}
const planJson = (n: number, skills?: string[]) =>
  JSON.stringify({
    ...(skills ? { skills } : {}),
    thought: 'Do it.',
    steps: Array.from({ length: n }, (_, i) => ({
      id: `s${i + 1}`,
      description: `Step s${i + 1}`,
      expectedOutcome: 'done',
      suggestedTools: [],
    })),
  })

const run = async (opts: {
  history?: { role: 'user' | 'assistant'; content: string }[]
  steps?: number
  stepText?: string
  systemPrompt?: string
  tools?: IAgentConfig['tools']
  strategy?: IAgentConfig['toolSelectionStrategy']
  skills?: ISkill[]
  // Names the planner picks (so the skills' instructions become active for the run).
  pick?: string[]
}) => {
  const script: Script = (req) => {
    switch (stageOf(req)) {
      case 'planner':
        return { text: planJson(opts.steps ?? 1, opts.pick) }
      case 'compact-history':
        return { text: 'HISTORY-SUMMARY' }
      case 'compact-trace':
        return { text: 'TRACE-SUMMARY' }
      case 'executor':
        return { text: opts.stepText ?? 'ok' }
      default:
        return { text: 'Done.' }
    }
  }
  const llm: ILocalOpenAI = await startLocalOpenAI(script)
  let agent: IAgent | undefined
  try {
    agent = await createAgent({
      clientName: 'compaction-window',
      providerType: 'openai-compatible',
      baseURL: llm.baseURL,
      apiKey: 'not-a-real-key',
      model: 'scripted',
      mcpServers: {},
      maxIterations: 12,
      maxStepsPerTask: 4,
      logLevel: 'none',
      llmMaxRetries: 0,
      systemPrompt: opts.systemPrompt,
      ...(opts.tools ? { tools: opts.tools } : {}),
      ...(opts.strategy ? { toolSelectionStrategy: opts.strategy } : {}),
      ...(opts.skills ? { skills: opts.skills } : {}),
      compaction: { contextWindowTokens: 10_000, keepRecentSteps: 1 },
    })
    const events: AgentEvent[] = []
    const result = await agent.run({
      input: 'go',
      ...(opts.history ? { history: opts.history } : {}),
      onEvent: (e) => events.push(e),
    })
    const order = llm.requests.map(stageOf)
    const compactHistoryPrompts = llm.requests
      .filter((r) => stageOf(r) === 'compact-history')
      .map((r) => userOf(r))
    return {
      order,
      scopes: events.flatMap((e) => (e.type === 'context.compacted' ? [e.scope] : [])),
      result,
      compactHistoryPrompts,
    }
  } finally {
    await agent?.close().catch(() => {})
    await llm.close()
  }
}

// 8 turns of `char`, as many as make them weigh about `tokens` BY THE ESTIMATOR ITSELF (so the
// scenarios keep their meaning if the estimate is ever recalibrated). The default keeps 4 verbatim.
const turns = (tokens: number, char = 'x') => {
  const make = (n: number) =>
    Array.from({ length: 8 }, (_, i) => ({
      role: (i % 2 ? 'assistant' : 'user') as 'user' | 'assistant',
      content: char.repeat(n),
    }))
  let lo = 1
  let hi = 200_000
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2)
    if (estimateTokens(renderTurns(make(mid))) <= tokens) lo = mid
    else hi = mid - 1
  }
  return make(lo)
}

// Window 10 000 -> threshold 8 500 (85%); the fixed prompt is 1 500 tokens plus whatever the
// scenario adds (system prompt, tools, skills).
test('history: the fixed prompt counts - a history under the threshold alone still compacts', async () => {
  const under = await run({ history: turns(5_000) })
  assert.deepEqual(under.scopes, [], '5 000 + 1 500 < 8 500')
  assert.ok(!under.order.includes('compact-history'))
  const over = await run({ history: turns(7_500) })
  assert.deepEqual(
    over.scopes,
    ['history'],
    '7 500 alone is under 8 500; with the prompt it is not',
  )
  assert.equal(over.order[0], 'compact-history', 'before planning')
  assert.equal(over.result.compactedHistory?.length, 5)
})

test('history: the same characters weigh differently - numbers cost more than prose', async () => {
  // 1 000 characters a turn: prose is ~0.44 tokens a character, digits ~1.1.
  const chars = (n: number, c: string) =>
    Array.from({ length: 8 }, (_, i) => ({
      role: (i % 2 ? 'assistant' : 'user') as 'user' | 'assistant',
      content: c.repeat(n),
    }))
  assert.deepEqual((await run({ history: chars(1_000, 'x') })).scopes, [], 'prose: ~3 600 tokens')
  const digits = await run({ history: chars(1_000, '7') })
  assert.deepEqual(digits.scopes, ['history'], 'digits: ~8 900 tokens')
  const russian = await run({ history: chars(1_000, 'ж') })
  assert.deepEqual(russian.scopes, [], 'Russian: ~4 400 - more than prose, nowhere near digits')
})

test('tool definitions count against the window - unless tool search is sending only a few', async () => {
  const big = tool({
    description: 'd'.repeat(8_000), // ~3 500 tokens of definition
    inputSchema: z.object({ q: z.string() }),
    execute: async () => 'x',
  })
  // 3 900 of history + 1 500 fixed = 5 400 fits an 8 500 threshold; with the tool (+3 500) it does not.
  const without = await run({ history: turns(3_900) })
  assert.ok(!without.order.includes('compact-history'))
  const withTool = await run({ history: turns(3_900), tools: { big }, strategy: 'all' })
  assert.equal(withTool.order[0], 'compact-history')
  // Under tool search the same catalogue weighs at most the allowance (3 000): 3 900 + 4 500 = 8 400.
  const searching = await run({ history: turns(3_900), tools: { big }, strategy: 'search' })
  assert.ok(
    !searching.order.includes('compact-history'),
    'search sends a few definitions at a time',
  )
})

// A system prompt that takes about `tokens` by the estimator ('p' = a letter, 0.44 a character).
const systemPromptOf = (tokens: number) => 'p'.repeat(Math.round(tokens / 0.44))

test('trace: it shares the window with the fixed prompt', async () => {
  // A 6 500-token system prompt leaves the trace ~500 tokens under an 8 500 threshold.
  const tight = await run({
    steps: 6,
    stepText: 'y'.repeat(500),
    systemPrompt: systemPromptOf(6_500),
  })
  assert.ok(tight.scopes.includes('trace'), 'the trace was folded')
  const roomy = await run({ steps: 6, stepText: 'y'.repeat(500) })
  assert.ok(!roomy.scopes.includes('trace'), 'the same trace fits when nothing else is in the way')
})

test('trace: it shares the window with the history too', async () => {
  // History 5 600 + fixed 1 500 = 7 100 < 8 500: no compaction at the start. The trace has ~1 400.
  const r = await run({ history: turns(5_600), steps: 8, stepText: 'y'.repeat(560) })
  assert.notEqual(r.order[0], 'compact-history')
  assert.ok(r.scopes.includes('trace'))
  // Without the history in the way the same trace fits.
  const alone = await run({ steps: 8, stepText: 'y'.repeat(560) })
  assert.ok(!alone.scopes.includes('trace'))
})

test('a long history is summarised through a window-sized lens', async () => {
  // Older turns ~7 000 tokens; the summariser may be shown 60% of a 10 000 window.
  const r = await run({ history: turns(14_000) })
  const shown = r.compactHistoryPrompts[0]
  assert.ok(shown, 'the history was summarised')
  assert.ok(estimateTokens(shown) <= 6_200, `${estimateTokens(shown)} tokens shown`)
  assert.ok(estimateTokens(shown) >= 5_000, 'and most of what fits')
})

test('active skills count against the window - the index alone is small, the instructions are not', async () => {
  const big: ISkill = {
    name: 'big',
    description: 'A very long procedure',
    content: 'k'.repeat(15_000), // ~6 600 tokens
  }
  // ~6 600 tokens of instructions leave the trace ~400 tokens under an 8 500 threshold.
  const picked = await run({ steps: 6, stepText: 'y'.repeat(500), skills: [big], pick: ['big'] })
  assert.ok(picked.scopes.includes('trace'), 'active: the instructions take the room')
  // Listed but not picked: only the one-line index is in the prompt.
  const listed = await run({ steps: 6, stepText: 'y'.repeat(500), skills: [big] })
  assert.ok(!listed.scopes.includes('trace'))
})

test('toolDefinitionTokens reads a tool’s schema once, not on every compaction check', async () => {
  let reads = 0
  const counted = {
    description: 'counted',
    get inputSchema() {
      reads += 1
      return z.object({ q: z.string() })
    },
    execute: async () => 'x',
  }
  const tools = { counted } as never
  const first = await toolDefinitionTokens(tools)
  const second = await toolDefinitionTokens(tools)
  assert.equal(first, second)
  assert.equal(reads, 1)
})
