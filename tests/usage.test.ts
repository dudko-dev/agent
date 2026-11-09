import assert from 'node:assert/strict'
import test from 'node:test'
import {
  createAgent,
  type AgentEvent,
  type IAgent,
  type IAgentConfig,
  type IPersistence,
  type IRunSnapshot,
  type IUsage,
} from '../src/index.ts'
import {
  startLocalOpenAI,
  systemOf,
  type IChatRequest,
  type ILocalOpenAI,
  type Script,
} from './helpers/openai-server.ts'

// What the agent has spent, over all its runs - counted call by call as the usage arrives, so a
// run that is stopped still counts what it used, a resumed one only what THIS process spent, and
// a manual compaction is counted too. (Per run it is `result.usage`; this is the agent's total.)

const stageOf = (req: IChatRequest): string => {
  const system = systemOf(req)
  if (system.includes('You are the Planner')) return 'planner'
  if (system.includes('You are the Replanner')) return 'replanner'
  if (system.includes('You are the Synthesizer')) return 'synthesizer'
  if (system.includes('You compress conversation history')) return 'compact-history'
  if (system.includes('You compress the execution trace')) return 'compact-trace'
  return 'executor'
}
const planJson = (n: number) =>
  JSON.stringify({
    thought: 'Do it.',
    steps: Array.from({ length: n }, (_, i) => ({
      id: `s${i + 1}`,
      description: `Step s${i + 1}`,
      expectedOutcome: 'done',
      suggestedTools: [],
    })),
  })
const USAGE = { prompt: 100, completion: 20 } // 120 a call

const script =
  (steps = 1): Script =>
  (req) => {
    switch (stageOf(req)) {
      case 'planner':
        return { text: planJson(steps), usage: USAGE }
      case 'replanner':
        return { text: JSON.stringify({ mode: 'continue', reason: 'ok' }), usage: USAGE }
      case 'compact-history':
        return { text: 'SUMMARY', usage: { prompt: 50, completion: 10 } }
      case 'synthesizer':
        return { text: 'Done.', usage: USAGE }
      default:
        return { text: 'ok', usage: USAGE }
    }
  }

const open = async (
  s: Script,
  extra: Partial<IAgentConfig> = {},
): Promise<{ agent: IAgent; llm: ILocalOpenAI; close: () => Promise<void> }> => {
  const llm = await startLocalOpenAI(s)
  const agent = await createAgent({
    clientName: 'usage-test',
    providerType: 'openai-compatible',
    baseURL: llm.baseURL,
    apiKey: 'not-a-real-key',
    model: 'scripted',
    mcpServers: {},
    maxIterations: 6,
    maxStepsPerTask: 6,
    logLevel: 'none',
    llmMaxRetries: 0,
    ...extra,
  })
  return {
    agent,
    llm,
    close: async () => {
      await agent.close().catch(() => {})
      await llm.close()
    },
  }
}
const total = (u: IUsage): number => u.totalTokens

test('usage: the agent counts every run - the sum of what each run reported', async () => {
  const { agent, close } = await open(script())
  try {
    assert.equal(total(agent.usage), 0)
    const a = await agent.run({ input: 'one' })
    const b = await agent.run({ input: 'two' })
    assert.equal(total(a.usage), 3 * 120, 'planner + executor + synthesizer')
    assert.equal(total(agent.usage), total(a.usage) + total(b.usage))
    assert.equal(agent.usage.inputTokens, a.usage.inputTokens + b.usage.inputTokens)
    assert.equal(agent.usage.outputTokens, a.usage.outputTokens + b.usage.outputTokens)
  } finally {
    await close()
  }
})

test('usage: what you read is a snapshot, and resetUsage starts counting again', async () => {
  const { agent, close } = await open(script())
  try {
    await agent.run({ input: 'one' })
    const snap = agent.usage
    snap.totalTokens = 0
    snap.inputTokens = 0
    assert.equal(total(agent.usage), 360, 'changing the copy changed nothing')
    agent.resetUsage()
    assert.equal(total(agent.usage), 0)
    await agent.run({ input: 'two' })
    assert.equal(total(agent.usage), 360)
  } finally {
    await close()
  }
})

test('usage: runs that overlap are all counted', async () => {
  const { agent, close } = await open(script())
  try {
    const rs = await Promise.all([1, 2, 3].map((i) => agent.run({ input: `go ${i}` })))
    assert.equal(
      total(agent.usage),
      rs.reduce((n, r) => n + total(r.usage), 0),
    )
    assert.equal(total(agent.usage), 3 * 360)
  } finally {
    await close()
  }
})

test('usage: a run that is stopped still counts what it spent', async () => {
  const { agent, close } = await open(script(3))
  try {
    const controller = new AbortController()
    let seen = 0
    await assert.rejects(
      agent.run({
        input: 'go',
        signal: controller.signal,
        onEvent: (e: AgentEvent) => {
          if (e.type === 'usage') seen += e.usage.totalTokens
          if (e.type === 'step.start') controller.abort()
        },
      }),
      /abort/i,
    )
    assert.ok(seen >= 120, 'the planner call was reported')
    assert.equal(total(agent.usage), seen, 'and counted - exactly what the events showed')
  } finally {
    await close()
  }
})

test('usage: a resumed run adds only what this process spent after the crash', async () => {
  const saved = new Map<string, IRunSnapshot>()
  const controller = new AbortController()
  const persistence: IPersistence = {
    onRunStart: (s) => void saved.set(s.runId, s),
    onStepComplete: (s) => {
      saved.set(s.runId, s)
      if (s.trace.length === 1) controller.abort()
    },
    loadRun: (id) => saved.get(id) ?? null,
  }
  const llm = await startLocalOpenAI(script(3))
  const agents: IAgent[] = []
  const mk = async () => {
    const a = await createAgent({
      clientName: 'usage-resume',
      providerType: 'openai-compatible',
      baseURL: llm.baseURL,
      apiKey: 'not-a-real-key',
      model: 'scripted',
      mcpServers: {},
      maxIterations: 6,
      maxStepsPerTask: 6,
      logLevel: 'none',
      llmMaxRetries: 0,
      persistence,
    })
    agents.push(a)
    return a
  }
  try {
    const first = await mk()
    await assert.rejects(first.run({ input: 'three things', signal: controller.signal }), /abort/i)
    const [runId] = [...saved.keys()]
    const savedTokens = saved.get(runId)!.usage.totalTokens
    assert.ok(savedTokens > 0)

    const second = await mk()
    const r = await second.run({ input: 'IGNORED', resumeFromRunId: runId })
    assert.ok(total(r.usage) > savedTokens, 'the run spans both processes')
    assert.equal(total(second.usage), total(r.usage) - savedTokens, 'this agent spent the rest')
  } finally {
    for (const a of agents) await a.close().catch(() => {})
    await llm.close()
  }
})

test('usage: a manual compaction is spend too', async () => {
  const { agent, close } = await open(script())
  try {
    const history = Array.from({ length: 10 }, (_, i) => ({
      role: i % 2 ? ('assistant' as const) : ('user' as const),
      content: `turn ${i}`,
    }))
    const r = await agent.compact({ history, force: true })
    assert.equal(r.compacted, true)
    assert.equal(total(agent.usage), 60)
  } finally {
    await close()
  }
})
