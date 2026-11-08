import assert from 'node:assert/strict'
import test from 'node:test'
import { isMainThread } from 'node:worker_threads'
import { asSchema, tool, type ToolSet } from 'ai'
import { z } from 'zod'
import {
  createAgent,
  createSubagentTool,
  markReadOnly,
  type AgentEvent,
  type IAgent,
  type IAgentConfig,
  type IPersistence,
  type IRunSnapshot,
  type IToolApprovalRequest,
} from '../src/index.ts'
import { runContext } from '../src/context.ts'
import { startLocalMcp } from './helpers/mcp-server.ts'
import {
  hasToolResult,
  startLocalOpenAI,
  systemOf,
  toolNames,
  toolResults,
  userOf,
  type IChatRequest,
  type ILocalOpenAI,
  type IScriptedReply,
  type Script,
} from './helpers/openai-server.ts'

// Every feature of the loop end-to-end over real sockets: a scripted
// OpenAI-compatible endpoint (the real provider package, the real wire
// format) and, where tools come from MCP, a real MCP server. The script
// answers per stage, recognised by the system prompt.

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

// Which plan step an executor request is for.
const stepOf = (req: IChatRequest): string =>
  /CURRENT STEP to execute \(id=([^)]+)\)/.exec(userOf(req))?.[1] ?? '?'

const planJson = (steps: { id: string; suggestedTools?: string[] }[], skills?: string[]) =>
  JSON.stringify({
    thought: 'Do it step by step.',
    steps: steps.map((s) => ({
      id: s.id,
      description: `Step ${s.id}`,
      expectedOutcome: `${s.id} done`,
      suggestedTools: s.suggestedTools ?? [],
    })),
    ...(skills ? { skills } : {}),
  })

const config = (baseURL: string, extra: Partial<IAgentConfig> = {}): IAgentConfig => ({
  clientName: 'features-test',
  providerType: 'openai-compatible',
  baseURL,
  apiKey: 'not-a-real-key',
  model: 'scripted',
  mcpServers: {},
  maxIterations: 6,
  maxStepsPerTask: 6,
  logLevel: 'none',
  ...extra,
})

const withLlm = async (
  script: Script,
  body: (ctx: { llm: ILocalOpenAI; open: (c: IAgentConfig) => Promise<IAgent> }) => Promise<void>,
): Promise<void> => {
  const llm = await startLocalOpenAI(script)
  const agents: IAgent[] = []
  try {
    await body({
      llm,
      open: async (c) => {
        const agent = await createAgent(c)
        agents.push(agent)
        return agent
      },
    })
  } finally {
    for (const agent of agents) await agent.close().catch(() => {})
    await llm.close()
  }
}

const collect = () => {
  const events: AgentEvent[] = []
  return { events, onEvent: (e: AgentEvent) => events.push(e) }
}

const ofType = <T extends AgentEvent['type']>(events: AgentEvent[], type: T) =>
  events.filter((e): e is Extract<AgentEvent, { type: T }> => e.type === type)

// ── tool approval ──────────────────────────────────────────────────────────

test('approval: ask-writes asks for a write tool once (remember), read-only tools run unasked', async () => {
  const mcp = await startLocalMcp()
  const script: Script = (req) => {
    const stage = stageOf(req)
    if (stage === 'planner') {
      return { text: planJson([{ id: 's1', suggestedTools: ['files__echo', 'files__secret'] }]) }
    }
    if (stage === 'synthesizer') return { text: 'done' }
    const results = toolResults(req).length
    if (results === 0) {
      return {
        toolCalls: [
          { name: 'files__secret', args: {} },
          { name: 'files__echo', args: { text: 'a' } },
        ],
      }
    }
    if (results === 2) return { toolCalls: [{ name: 'files__echo', args: { text: 'b' } }] }
    return { text: 'Echoed twice and read the secret.' }
  }
  try {
    await withLlm(script, async ({ llm, open }) => {
      const requests: IToolApprovalRequest[] = []
      const agent = await open(
        config(llm.baseURL, {
          mcpServers: { files: { url: mcp.url } },
          toolApproval: {
            mode: 'ask-writes',
            onRequest: (req) => {
              requests.push(req)
              return { approved: true, remember: true }
            },
          },
        }),
      )
      assert.equal(agent.listTools().find((t) => t.name === 'files__secret')?.readOnly, true)
      const { events, onEvent } = collect()
      const result = await agent.run({ input: 'Read the secret and echo twice', onEvent })

      assert.deepEqual(
        requests.map((r) => r.toolName),
        ['files__echo'],
        'asked once, for the write tool only',
      )
      assert.deepEqual(requests[0].input, { text: 'a' })
      assert.equal(requests[0].readOnly, false)
      assert.equal(requests[0].step?.id, 's1')
      // secret and the first echo ran in parallel: compare as a multiset.
      assert.deepEqual(mcp.calls.map((c) => c.name).sort(), ['echo', 'echo', 'secret'])
      assert.ok(result.trace[0].toolCalls.every((c) => c.ok))
      assert.equal(ofType(events, 'tool.approval-requested').length, 1)
      const resolved = ofType(events, 'tool.approval-resolved')
      assert.equal(resolved.length, 1)
      assert.equal(resolved[0].approved, true)
      assert.equal(resolved[0].automatic, false)
      assert.ok(resolved[0].runId, 'gate events are tagged with the run')

      // The executor's system prompt is run-stable across its LLM steps.
      const execSystems = new Set(
        llm.requests.filter((r) => stageOf(r) === 'executor').map(systemOf),
      )
      assert.equal(execSystems.size, 1)
    })
  } finally {
    await mcp.close()
  }
})

test('approval: a denied call fails with ToolDeniedError; read-only mode denies automatically', async () => {
  const mcp = await startLocalMcp()
  const script: Script = (req) => {
    const stage = stageOf(req)
    if (stage === 'planner') return { text: planJson([{ id: 's1' }]) }
    if (stage === 'synthesizer') return { text: 'could not echo' }
    if (hasToolResult(req)) return { text: 'The echo was denied.' }
    return { toolCalls: [{ name: 'files__echo', args: { text: 'nope' } }] }
  }
  try {
    await withLlm(script, async ({ llm, open }) => {
      const agent = await open(
        config(llm.baseURL, {
          mcpServers: { files: { url: mcp.url } },
          toolApproval: { mode: 'ask-all', onRequest: () => ({ approved: false, reason: 'no' }) },
        }),
      )
      const first = await agent.run({ input: 'Echo nope' })
      const call = first.trace[0].toolCalls[0]
      assert.equal(call.ok, false)
      assert.match(String(JSON.parse(JSON.stringify(call.output))), /denied by the user: no/)
      // The model saw the denial as the tool result.
      const denialSeen = llm.requests.some((r) =>
        toolResults(r).some((t) => t.includes('Tool call denied by the user')),
      )
      assert.ok(denialSeen)
      assert.deepEqual(mcp.calls, [], 'the denied call never reached the server')

      // The runtime switch applies to the next call: read-only denies writes
      // without asking.
      agent.setToolApprovalMode('read-only')
      assert.equal(agent.getToolApprovalMode(), 'read-only')
      const { events, onEvent } = collect()
      await agent.run({ input: 'Echo nope', onEvent })
      assert.equal(ofType(events, 'tool.approval-requested').length, 0)
      const resolved = ofType(events, 'tool.approval-resolved')
      assert.equal(resolved.length, 1)
      assert.equal(resolved[0].automatic, true)
      assert.equal(resolved[0].approved, false)
      assert.deepEqual(mcp.calls, [])
    })
  } finally {
    await mcp.close()
  }
})

// ── tool search ────────────────────────────────────────────────────────────

test('tool search: >40 tools switch auto to search; find_tools activates a tool for the next step and later steps', async () => {
  const weatherCalls: unknown[] = []
  const tools: ToolSet = {}
  for (let i = 0; i < 45; i++) {
    tools[`bulk_${i}`] = tool({
      description: `Bulk utility number ${i}`,
      inputSchema: z.object({}),
      execute: async () => i,
    })
  }
  tools.weather_lookup = markReadOnly(
    tool({
      description: 'Look up the weather forecast for a city',
      inputSchema: z.object({ city: z.string() }),
      execute: async ({ city }) => {
        weatherCalls.push(city)
        return `Sunny in ${city}`
      },
    }),
  )
  const script: Script = (req) => {
    const stage = stageOf(req)
    if (stage === 'planner') return { text: planJson([{ id: 's1' }, { id: 's2' }]) }
    if (stage === 'synthesizer') return { text: 'It is sunny in Oslo.' }
    if (stepOf(req) === 's2') return { text: 'Nothing else to do.' }
    const results = toolResults(req).length
    if (results === 0)
      return { toolCalls: [{ name: 'find_tools', args: { query: 'weather forecast' } }] }
    if (results === 1) return { toolCalls: [{ name: 'weather_lookup', args: { city: 'Oslo' } }] }
    return { text: 'Sunny in Oslo.' }
  }
  await withLlm(script, async ({ llm, open }) => {
    const agent = await open(config(llm.baseURL, { tools }))
    const { events, onEvent } = collect()
    const result = await agent.run({ input: 'Weather in Oslo?', onEvent })

    assert.equal(result.text, 'It is sunny in Oslo.')
    assert.deepEqual(weatherCalls, ['Oslo'])
    const exec = llm.requests.filter((r) => stageOf(r) === 'executor')
    assert.deepEqual(toolNames(exec[0]), ['find_tools'], 'a step starts with the built-ins only')
    assert.deepEqual(toolNames(exec[1]).sort(), ['find_tools', 'weather_lookup'])
    assert.ok(!toolNames(exec[1]).includes('bulk_0'))
    const s2 = exec.find((r) => stepOf(r) === 's2')!
    assert.ok(toolNames(s2).includes('weather_lookup'), 'discovered tools carry into later steps')
    const discovered = ofType(events, 'tools.discovered')
    assert.equal(discovered.length, 1)
    assert.equal(discovered[0].query, 'weather forecast')
    assert.equal(discovered[0].names[0], 'weather_lookup')
    // The planner sees the abridged catalogue and the search-mode rule.
    const planner = llm.requests.find((r) => stageOf(r) === 'planner')!
    assert.match(systemOf(planner), /tool-search mode/)
    assert.match(systemOf(planner), /\[<native>\]\n- bulk_0: Bulk utility number 0/)
    assert.equal(new Set(exec.map(systemOf)).size, 1, 'one executor system prompt per run')
  })
})

// ── token limits, tool-call cap, thinking, usage details ───────────────────

test('limits: a token cap stops a runaway tool loop at the next LLM step and skips to synthesis', async () => {
  let noopCalls = 0
  const script: Script = (req) => {
    const stage = stageOf(req)
    if (stage === 'planner') return { text: planJson([{ id: 's1' }, { id: 's2' }, { id: 's3' }]) }
    if (stage === 'synthesizer') return { text: 'Partial answer.' }
    return { toolCalls: [{ name: 'noop', args: {} }] } // never stops on its own
  }
  await withLlm(script, async ({ llm, open }) => {
    const agent = await open(
      config(llm.baseURL, {
        maxStepsPerTask: 10,
        limits: { maxTotalTokens: 40, perCall: { synthesizer: 77 } },
        tools: {
          noop: tool({
            description: 'Does nothing',
            inputSchema: z.object({}),
            execute: async () => {
              noopCalls++
              return 'ok'
            },
          }),
        },
      }),
    )
    const { events, onEvent } = collect()
    const result = await agent.run({ input: 'Loop forever', onEvent })

    // 15 tokens per call: plan 15, then the executor's 2nd LLM step reaches
    // 15 + 30 = 45 >= 40 and stops the loop.
    assert.equal(llm.requests.filter((r) => stageOf(r) === 'executor').length, 2)
    assert.equal(noopCalls, 2)
    assert.equal(result.trace.length, 1, 'no further plan step ran')
    assert.match(result.trace[0].summary, /token budget/)
    assert.deepEqual(
      ofType(events, 'budget.exceeded').map(({ kind, tokens, cap }) => ({ kind, tokens, cap })),
      [{ kind: 'total', tokens: 45, cap: 40 }],
    )
    assert.equal(result.text, 'Partial answer.', 'synthesis still runs')
    assert.equal(result.usage.totalTokens, 60)
    assert.equal(ofType(events, 'replan.decision').length, 0, 'no replanner after the breach')
    const synth = llm.requests.find((r) => stageOf(r) === 'synthesizer') as unknown as {
      max_tokens?: number
    }
    assert.equal(synth.max_tokens, 77, 'perCall.synthesizer caps the synthesis call')
  })
})

test('limits: maxToolCalls fails calls past the cap and reports kind "tool-calls"', async () => {
  const script: Script = (req) => {
    const stage = stageOf(req)
    if (stage === 'planner') return { text: planJson([{ id: 's1' }, { id: 's2' }]) }
    if (stage === 'synthesizer') return { text: 'Stopped.' }
    return {
      toolCalls: [
        { name: 'noop', args: {} },
        { name: 'noop', args: {} },
        { name: 'noop', args: {} },
      ],
    }
  }
  await withLlm(script, async ({ llm, open }) => {
    let calls = 0
    const agent = await open(
      config(llm.baseURL, {
        maxToolCalls: 2,
        tools: {
          noop: tool({
            description: 'Does nothing',
            inputSchema: z.object({}),
            execute: async () => ++calls,
          }),
        },
      }),
    )
    const { events, onEvent } = collect()
    const result = await agent.run({ input: 'Call a lot', onEvent })
    assert.equal(calls, 2)
    // The three calls ran in parallel; results arrive in completion order.
    const outcomes = result.trace[0].toolCalls
    assert.equal(outcomes.filter((c) => c.ok).length, 2)
    const failed = outcomes.filter((c) => !c.ok)
    assert.equal(failed.length, 1)
    assert.match(String(JSON.parse(JSON.stringify(failed[0].output))), /tool-call budget exhausted/)
    assert.deepEqual(
      ofType(events, 'budget.exceeded').map(({ kind, tokens, cap }) => ({ kind, tokens, cap })),
      [{ kind: 'tool-calls', tokens: 2, cap: 2 }],
    )
    assert.equal(result.trace.length, 1)
    assert.equal(llm.requests.filter((r) => stageOf(r) === 'executor').length, 1)
  })
})

test('thinking: reasoning reaches the wire, thoughts stream, usage details accumulate', async () => {
  const usage = { prompt: 100, completion: 20, cached: 60, reasoning: 8 }
  const script: Script = (req): IScriptedReply => {
    const stage = stageOf(req)
    if (stage === 'planner') return { text: planJson([{ id: 's1' }]), usage }
    if (stage === 'synthesizer') return { text: 'Answer.', reasoning: 'Summing up.', usage }
    return { text: 'Did it.', reasoning: 'Let me think.', usage }
  }
  await withLlm(script, async ({ llm, open }) => {
    const agent = await open(
      config(llm.baseURL, { thinking: 'high', stageThinking: { planner: false } }),
    )
    const { events, onEvent } = collect()
    const result = await agent.run({ input: 'Think about it', onEvent })

    const effort = (stage: Stage) =>
      (llm.requests.find((r) => stageOf(r) === stage) as unknown as { reasoning_effort?: string })
        .reasoning_effort
    assert.equal(effort('executor'), 'high')
    assert.equal(effort('synthesizer'), 'high')
    assert.equal(effort('planner'), undefined, 'stageThinking.planner: false wins')
    assert.equal(
      ofType(events, 'step.reasoning-delta')
        .map((e) => e.delta)
        .join(''),
      'Let me think.',
    )
    assert.equal(
      ofType(events, 'final.reasoning-delta')
        .map((e) => e.delta)
        .join(''),
      'Summing up.',
    )
    assert.equal(result.text, 'Answer.')
    assert.deepEqual(result.usage, {
      inputTokens: 300,
      outputTokens: 60,
      totalTokens: 360,
      reasoningTokens: 24,
      cachedInputTokens: 180,
      cacheWriteTokens: 0,
    })
  })
})

// ── skills ─────────────────────────────────────────────────────────────────

test('skills: the plan activates one, load_skill another; instructions reach later stages', async () => {
  const script: Script = (req) => {
    const stage = stageOf(req)
    if (stage === 'planner') {
      return { text: planJson([{ id: 's1' }, { id: 's2' }], ['alpha', 'ghost']) }
    }
    if (stage === 'synthesizer') return { text: 'Followed both skills.' }
    if (stepOf(req) === 's2') return { text: 's2 done' }
    if (hasToolResult(req)) return { text: 'Loaded beta.' }
    return { toolCalls: [{ name: 'load_skill', args: { name: 'beta' } }] }
  }
  await withLlm(script, async ({ llm, open }) => {
    const logs: string[] = []
    const agent = await createAgent(
      config(llm.baseURL, {
        logLevel: 'warn',
        // Built-ins never need approval, even in ask-all without a handler.
        toolApproval: { mode: 'ask-all' },
        skills: [
          { name: 'alpha', description: 'Alpha work', content: 'ALPHA-INSTRUCTIONS' },
          {
            name: 'beta',
            description: 'Beta work',
            content: 'BETA-INSTRUCTIONS',
            files: [{ path: 'ref.md', content: 'ref' }],
          },
        ],
      }),
      (e) => {
        if (e.type === 'log') logs.push(e.message)
      },
    )
    try {
      assert.deepEqual(agent.listSkills(), [
        { name: 'alpha', description: 'Alpha work' },
        { name: 'beta', description: 'Beta work' },
      ])
      const { events, onEvent } = collect()
      const result = await agent.run({ input: 'Do alpha and beta work', onEvent })

      assert.deepEqual(result.plan.skills, ['alpha'])
      assert.ok(logs.some((m) => m.includes('dropped unknown skills: ghost')))
      assert.deepEqual(
        ofType(events, 'skill.activated').map((e) => `${e.name}:${e.by}`),
        ['alpha:plan', 'beta:tool'],
      )
      const call = result.trace[0].toolCalls[0]
      assert.equal(call.ok, true)
      assert.deepEqual(call.output, {
        name: 'beta',
        content: 'BETA-INSTRUCTIONS',
        files: ['ref.md'],
      })

      const planner = llm.requests.find((r) => stageOf(r) === 'planner')!
      assert.match(systemOf(planner), /SKILLS:\n- alpha: Alpha work\n- beta: Beta work/)
      const exec = llm.requests.filter((r) => stageOf(r) === 'executor')
      const s1 = systemOf(exec.find((r) => stepOf(r) === 's1')!)
      const s2 = systemOf(exec.find((r) => stepOf(r) === 's2')!)
      assert.ok(s1.includes('ALPHA-INSTRUCTIONS') && !s1.includes('BETA-INSTRUCTIONS'))
      assert.ok(s2.includes('ALPHA-INSTRUCTIONS') && s2.includes('BETA-INSTRUCTIONS'))
      assert.ok(toolNames(exec[0]).includes('load_skill'))
      const synth = systemOf(llm.requests.find((r) => stageOf(r) === 'synthesizer')!)
      assert.ok(synth.includes('ALPHA-INSTRUCTIONS') && synth.includes('BETA-INSTRUCTIONS'))
    } finally {
      await agent.close()
    }
  })
})

test('skills: a host tool named load_skill collides with the built-in', async () => {
  await assert.rejects(
    () =>
      createAgent(
        config('http://127.0.0.1:9/v1', {
          skills: [{ name: 'a', description: 'd', content: 'c' }],
          tools: {
            load_skill: tool({
              description: 'x',
              inputSchema: z.object({}),
              execute: async () => 1,
            }),
          },
        }),
      ),
    /collides with a built-in skill tool/,
  )
})

// ── compaction ─────────────────────────────────────────────────────────────

test('compaction: history at run start and the trace before later stages, with a low threshold', async () => {
  const script: Script = (req) => {
    const stage = stageOf(req)
    if (stage === 'planner') return { text: planJson([{ id: 's1' }, { id: 's2' }, { id: 's3' }]) }
    if (stage === 'compact-history') return { text: 'HISTORY-SUMMARY' }
    if (stage === 'compact-trace') return { text: 'TRACE-SUMMARY' }
    if (stage === 'synthesizer') return { text: 'All three done.' }
    return { text: `${stepOf(req)} result` }
  }
  await withLlm(script, async ({ llm, open }) => {
    let finalSnapshot: IRunSnapshot | undefined
    const agent = await open(
      config(llm.baseURL, {
        compaction: { thresholdTokens: 1, keepRecentSteps: 1, keepRecentTurns: 2 },
        persistence: {
          onRunComplete: (s) => {
            finalSnapshot = s
          },
        },
      }),
    )
    const history = Array.from({ length: 6 }, (_, i) => ({
      role: i % 2 ? ('assistant' as const) : ('user' as const),
      content: `old turn ${i}`,
    }))
    const frozen = JSON.stringify(history)
    const { events, onEvent } = collect()
    const result = await agent.run({ input: 'Do three things', history, onEvent })

    assert.equal(JSON.stringify(history), frozen, "the caller's history is not mutated")
    assert.equal(result.compactedHistory?.length, 3)
    assert.match(
      result.compactedHistory![0].content,
      /^\[Summary of earlier conversation\]\nHISTORY-SUMMARY/,
    )
    assert.deepEqual(result.compactedHistory!.slice(1), history.slice(4))
    const planner = llm.requests.find((r) => stageOf(r) === 'planner')!
    assert.ok(userOf(planner).includes('HISTORY-SUMMARY'))
    assert.ok(!userOf(planner).includes('old turn 0'))

    const compacted = ofType(events, 'context.compacted')
    assert.deepEqual(
      compacted.map((e) => e.scope),
      ['history', 'trace', 'trace'],
    )
    // Before step 3: steps [0,1) folded; before synthesis: [0,2).
    const s3 = llm.requests.find((r) => stageOf(r) === 'executor' && stepOf(r) === 's3')!
    assert.match(userOf(s3), /Summary of earlier steps \(1-1\): TRACE-SUMMARY/)
    assert.match(userOf(s3), /Step 2: Step s2/)
    const synth = llm.requests.find((r) => stageOf(r) === 'synthesizer')!
    assert.match(userOf(synth), /Summary of earlier steps \(1-2\): TRACE-SUMMARY\nStep 3: Step s3/)
    // Compaction calls never think and their usage counts (phase 'compact').
    assert.equal(ofType(events, 'usage').filter((e) => e.phase === 'compact').length, 3)
    assert.equal(result.trace.length, 3, 'the trace itself stays intact')
    assert.equal(finalSnapshot?.traceSummary, 'TRACE-SUMMARY')
    assert.equal(finalSnapshot?.traceSummaryUpTo, 2)

    // Manual compaction of a history.
    const manual = await agent.compact({ history, force: true })
    assert.equal(manual.compacted, true)
    assert.equal(manual.history.length, 3)
    assert.equal(manual.summary, 'HISTORY-SUMMARY')
  })
})

// ── subagents ──────────────────────────────────────────────────────────────

const subagentScript: Script = (req) => {
  const stage = stageOf(req)
  const child = systemOf(req).includes('CHILD AGENT')
  if (stage === 'planner') return { text: planJson([{ id: 's1' }]) }
  if (child) {
    if (stage === 'synthesizer') return { text: 'child answer: host-value-42' }
    if (hasToolResult(req)) return { text: `child saw ${toolResults(req)[0]}` }
    return { toolCalls: [{ name: 'host_lookup', args: { key: 'k' } }] }
  }
  if (stage === 'synthesizer') return { text: 'Parent done.' }
  if (hasToolResult(req)) return { text: `parent got ${toolResults(req)[0]}` }
  return {
    toolCalls: [{ name: 'researcher', args: { task: 'Find the value for key k' } }],
  }
}

for (const isolation of ['worker', 'in-process'] as const) {
  test(`subagent (${isolation}): proxies a host tool, returns its text, folds usage into the parent`, async () => {
    await withLlm(subagentScript, async ({ llm, open }) => {
      const hostCalls: { key: string; mainThread: boolean }[] = []
      const host_lookup = tool({
        description: 'Look up a value on the host',
        inputSchema: z.object({ key: z.string() }),
        execute: async ({ key }) => {
          hostCalls.push({ key, mainThread: isMainThread })
          return 'host-value-42'
        },
      })
      const researcher = createSubagentTool({
        name: 'researcher',
        description: 'Delegate a research task',
        isolation,
        config: config(llm.baseURL, { systemPrompt: 'CHILD AGENT', maxIterations: 2 }),
        tools: { host_lookup },
        timeoutMs: 20_000,
      })
      const agent = await open(config(llm.baseURL, { tools: { researcher } }))
      const { events, onEvent } = collect()
      const result = await agent.run({ input: 'Research it', onEvent })

      assert.deepEqual(hostCalls, [{ key: 'k', mainThread: true }])
      const call = result.trace[0].toolCalls[0]
      assert.equal(call.name, 'researcher')
      assert.equal(call.ok, true, JSON.stringify(call.output))
      assert.equal(call.output, 'child answer: host-value-42')
      assert.equal(result.text, 'Parent done.')

      const start = ofType(events, 'subagent.start')
      const complete = ofType(events, 'subagent.complete')
      assert.equal(start.length, 1)
      assert.equal(start[0].task, 'Find the value for key k')
      assert.equal(complete.length, 1)
      assert.equal(complete[0].id, start[0].id)
      assert.equal(complete[0].text, 'child answer: host-value-42')
      // Child: plan + 2 executor steps + synthesis = 4 calls x 15 tokens.
      assert.equal(complete[0].usage.totalTokens, 60)
      const forwarded = ofType(events, 'subagent.event').map((e) => e.event.type)
      assert.ok(forwarded.includes('plan.created') && forwarded.includes('final'))
      const childUsage = ofType(events, 'usage').filter((e) => e.phase === 'subagent')
      assert.equal(
        childUsage.reduce((n, e) => n + e.usage.totalTokens, 0),
        60,
      )
      // Parent: 4 calls x 15 + the child's 60.
      assert.equal(result.usage.totalTokens, 120)
    })
  })
}

test('subagent: worker isolation refuses a config with functions', () => {
  assert.throws(
    () =>
      createSubagentTool({
        name: 'bad',
        description: 'x',
        config: config('http://127.0.0.1:9/v1', { inputSanitizer: (_n, i) => i }),
      }),
    /config\.inputSanitizer is a function/,
  )
  assert.throws(
    () =>
      createSubagentTool({
        name: 'bad',
        description: 'x',
        config: config('http://127.0.0.1:9/v1', {
          tools: {
            t: tool({ description: 'x', inputSchema: z.object({}), execute: async () => 1 }),
          },
        }),
      }),
    /use the `tools` option/,
  )
})

test('maxPlanSteps caps the plan and is stated in the planner prompt', async () => {
  const script: Script = (req) => {
    const stage = stageOf(req)
    if (stage === 'planner') {
      return { text: planJson([{ id: 'a' }, { id: 'b' }, { id: 'c' }, { id: 'd' }]) }
    }
    if (stage === 'synthesizer') return { text: 'ok' }
    return { text: `${stepOf(req)} done` }
  }
  await withLlm(script, async ({ llm, open }) => {
    const agent = await open(config(llm.baseURL, { maxPlanSteps: 2 }))
    const result = await agent.run({ input: 'Many steps' })
    assert.deepEqual(
      result.plan.steps.map((s) => s.id),
      ['a', 'b'],
    )
    assert.equal(result.trace.length, 2)
    const planner = llm.requests.find((r) => stageOf(r) === 'planner')!
    assert.match(systemOf(planner), /hard cap is 2\)/)
  })
})

// A child whose only tool never returns: the parent's timeout / abort must
// still end the call (and the worker).
const hangingChildScript: Script = (req) => {
  const stage = stageOf(req)
  const child = systemOf(req).includes('CHILD AGENT')
  if (stage === 'planner') return { text: planJson([{ id: 's1' }]) }
  if (stage === 'synthesizer') return { text: child ? 'never' : 'Parent gave up waiting.' }
  if (child) return { toolCalls: [{ name: 'hang', args: {} }] }
  if (hasToolResult(req)) return { text: 'The subagent failed.' }
  return { toolCalls: [{ name: 'researcher', args: { task: 'Wait forever' } }] }
}

const hangTool = () =>
  tool({
    description: 'Never returns',
    inputSchema: z.object({}),
    execute: () => new Promise<string>(() => {}),
  })

test('subagent (worker): timeoutMs fails the call; the parent run carries on', async () => {
  await withLlm(hangingChildScript, async ({ llm, open }) => {
    const researcher = createSubagentTool({
      name: 'researcher',
      description: 'Delegate',
      config: config(llm.baseURL, { systemPrompt: 'CHILD AGENT' }),
      tools: { hang: hangTool() },
      timeoutMs: 300,
    })
    const agent = await open(config(llm.baseURL, { tools: { researcher } }))
    const { events, onEvent } = collect()
    const started = Date.now()
    const result = await agent.run({ input: 'Research', onEvent })
    assert.ok(Date.now() - started < 10_000)
    const call = result.trace[0].toolCalls[0]
    assert.equal(call.ok, false)
    assert.match(String((call.output as Error).message), /timed out after 300ms/)
    assert.equal(ofType(events, 'subagent.error').length, 1)
    assert.equal(result.text, 'Parent gave up waiting.')
  })
})

test('subagent (worker): aborting the parent run aborts the child', async () => {
  await withLlm(hangingChildScript, async ({ llm, open }) => {
    const researcher = createSubagentTool({
      name: 'researcher',
      description: 'Delegate',
      config: config(llm.baseURL, { systemPrompt: 'CHILD AGENT' }),
      tools: { hang: hangTool() },
    })
    const agent = await open(config(llm.baseURL, { tools: { researcher } }))
    const ac = new AbortController()
    const onEvent = (e: AgentEvent) => {
      // Abort once the child is stuck inside its tool call.
      if (e.type === 'subagent.event' && e.event.type === 'step.tool-call') {
        setTimeout(() => ac.abort(), 20)
      }
    }
    const started = Date.now()
    await assert.rejects(
      () => agent.run({ input: 'Research', signal: ac.signal, onEvent }),
      (err: unknown) => (err as Error).name === 'AbortError',
    )
    assert.ok(Date.now() - started < 10_000)
  })
})

// ── subagent profiles ──────────────────────────────────────────────────────
// The parent model picks a NAMED way to run the same subagent per call: another
// model, other params, another context. The proof is the `model` the child's
// HTTP requests carry — what actually went over the wire — not what an answer says.

type ToolLike = { execute: (input: unknown, options: unknown) => Promise<string> }
const callTool = (t: unknown, input: unknown) =>
  (t as ToolLike).execute(input, { toolCallId: 't', messages: [] })

/** A child answers with the name of the model it ran on; the parent delegates twice. */
const profileScript: Script = (req) => {
  const stage = stageOf(req)
  if (req.model === 'parent-model') {
    if (stage === 'planner') return { text: planJson([{ id: 's1' }]) }
    if (stage === 'executor') {
      return hasToolResult(req)
        ? { text: 'delegated' }
        : {
            toolCalls: [
              { name: 'research', args: { task: 'quick lookup' } },
              { name: 'research', args: { task: 'hard question', profile: 'deep' } },
            ],
          }
    }
    return { text: 'parent done' }
  }
  if (stage === 'planner') return { text: planJson([{ id: 'c1' }]) }
  if (stage === 'executor') return { text: `worked on ${req.model}` }
  return { text: `answer from ${req.model}` }
}

for (const isolation of ['in-process', 'worker'] as const) {
  test(`subagent profiles (${isolation}): the parent chooses per call, and the child runs on THAT model`, async () => {
    await withLlm(profileScript, async ({ llm, open }) => {
      const researcher = createSubagentTool({
        name: 'researcher',
        description: 'Research a question',
        isolation,
        config: config(llm.baseURL, { model: 'cheap-model', maxIterations: 2 }),
        profiles: {
          deep: {
            description: 'A strong model for a hard question',
            config: { model: 'strong-model' },
          },
        },
      })
      const agent = await open(
        config(llm.baseURL, { model: 'parent-model', tools: { research: researcher } }),
      )
      const { events, onEvent } = collect()
      const result = await agent.run({ input: 'research two things', onEvent })

      const outputs = result.trace[0].toolCalls.map((c) => c.output)
      assert.deepEqual(
        [...outputs].sort(),
        ['answer from cheap-model', 'answer from strong-model'],
        JSON.stringify(result.trace[0].toolCalls),
      )

      // The wire: each child reached only its own model, and each model saw only its own task.
      const child = llm.requests.filter((r) => r.model !== 'parent-model')
      assert.deepEqual([...new Set(child.map((r) => r.model))].sort(), [
        'cheap-model',
        'strong-model',
      ])
      const forModel = (m: string) => child.filter((r) => r.model === m)
      assert.ok(forModel('strong-model').some((r) => userOf(r).includes('hard question')))
      assert.ok(forModel('strong-model').every((r) => !userOf(r).includes('quick lookup')))
      assert.ok(forModel('cheap-model').every((r) => !userOf(r).includes('hard question')))

      const starts = ofType(events, 'subagent.start')
      assert.equal(starts.length, 2)
      assert.deepEqual(
        starts.map((e) => e.profile),
        starts.map((e) => (e.task === 'hard question' ? 'deep' : undefined)),
        'the event names the profile that was chosen, and omits it for the default',
      )
    })
  })
}

test("subagent profiles: a profile changes the child's context, not just its model", async () => {
  await withLlm(
    (req) =>
      stageOf(req) === 'planner'
        ? { text: planJson([{ id: 'c1' }]) }
        : stageOf(req) === 'executor'
          ? { text: 'worked' }
          : { text: `answer from ${req.model}` },
    async ({ llm }) => {
      const analyst = createSubagentTool({
        name: 'analyst',
        description: 'Analyse',
        isolation: 'in-process',
        config: config(llm.baseURL, { model: 'base-model', systemPrompt: 'BASE-CONTEXT' }),
        profiles: {
          careful: {
            description: 'Slow and careful',
            config: { model: 'careful-model', systemPrompt: 'CAREFUL-CONTEXT' },
          },
        },
      })
      assert.equal(await callTool(analyst, { task: 'one' }), 'answer from base-model')
      assert.equal(
        await callTool(analyst, { task: 'two', profile: 'careful' }),
        'answer from careful-model',
      )
      const on = (m: string) => llm.requests.filter((r) => r.model === m)
      assert.ok(on('base-model').length > 0 && on('careful-model').length > 0)
      assert.ok(
        on('base-model').every(
          (r) => systemOf(r).includes('BASE-CONTEXT') && !systemOf(r).includes('CAREFUL-CONTEXT'),
        ),
      )
      assert.ok(on('careful-model').every((r) => systemOf(r).includes('CAREFUL-CONTEXT')))
    },
  )
})

test('subagent profiles: the tool tells the parent what each profile is for; without them it is unchanged', async () => {
  const withProfiles = createSubagentTool({
    name: 'r',
    description: 'Research a question',
    isolation: 'in-process',
    config: config('http://unused.test'),
    profiles: {
      fast: { description: 'A quick shallow check' },
      deep: { description: 'A thorough investigation', config: { model: 'big' } },
    },
  })
  const schema = (await asSchema(withProfiles.inputSchema as never).jsonSchema) as {
    properties: Record<string, { enum?: string[] }>
    required?: string[]
  }
  assert.deepEqual(schema.properties.profile.enum, ['fast', 'deep'])
  assert.deepEqual(schema.required, ['task'], 'profile stays optional')
  // The description carries what each is FOR: a prompted-mode model reads the
  // catalogue, and would never learn what "deep" means from an enum alone.
  assert.match(String(withProfiles.description), /- fast: A quick shallow check/)
  assert.match(String(withProfiles.description), /- deep: A thorough investigation/)

  const plain = createSubagentTool({
    name: 'r',
    description: 'Research a question',
    isolation: 'in-process',
    config: config('http://unused.test'),
  })
  const plainSchema = (await asSchema(plain.inputSchema as never).jsonSchema) as {
    properties: Record<string, unknown>
  }
  assert.deepEqual(Object.keys(plainSchema.properties), ['task'])
  assert.equal(plain.description, 'Research a question')
})

test('subagent profiles: an unknown name is refused before any child starts', async () => {
  await withLlm(
    (req) =>
      stageOf(req) === 'planner'
        ? { text: planJson([{ id: 'c1' }]) }
        : { text: `answer from ${req.model}` },
    async ({ llm }) => {
      const r = createSubagentTool({
        name: 'r',
        description: 'Research',
        isolation: 'in-process',
        config: config(llm.baseURL, { model: 'base-model' }),
        profiles: { fast: { description: 'Quick' }, deep: { description: 'Slow' } },
      })
      // These bypass the schema (a prompted-mode model's call is not validated by
      // it), so this check is the one that has to hold.
      for (const bad of ['nope', 'constructor', '__proto__', 'toString']) {
        await assert.rejects(
          callTool(r, { task: 'x', profile: bad }),
          /unknown profile .*choose one of: fast, deep/,
        )
      }
      assert.equal(llm.requests.length, 0, 'no child was started for any of them')
      // An empty string is what a model sends for "none": it means the default.
      assert.equal(await callTool(r, { task: 'x', profile: '' }), 'answer from base-model')
    },
  )
})

test('subagent profiles: an unknown name is not announced either — checked where execute itself runs', async () => {
  // At the agent level the schema's enum rejects a bad name before `execute` is even
  // reached, so that route cannot tell whether execute validates BEFORE announcing.
  // Calling it inside a run context, where events are collected, can.
  await withLlm(
    () => ({ text: 'unused' }),
    async ({ llm }) => {
      const r = createSubagentTool({
        name: 'r',
        description: 'Research',
        isolation: 'in-process',
        config: config(llm.baseURL, { model: 'base-model' }),
        profiles: { deep: { description: 'Slow' } },
      })
      const { events, onEvent } = collect()
      const context = { runId: 'r1', startedAt: 0, sandboxDir: '/nonexistent', emit: onEvent }
      await runContext.run(context, async () => {
        await assert.rejects(callTool(r, { task: 'x', profile: 'nope' }), /unknown profile "nope"/)
      })
      assert.equal(
        events.length,
        0,
        'no start, no error, nothing announced for a call that never began',
      )
      assert.equal(llm.requests.length, 0)
    },
  )
})

test('subagent profiles: the parent model is told its mistake, and no delegation is announced', async () => {
  await withLlm(
    (req) => {
      const stage = stageOf(req)
      if (req.model === 'parent-model') {
        if (stage === 'planner') return { text: planJson([{ id: 's1' }]) }
        if (stage === 'executor') {
          return hasToolResult(req)
            ? { text: 'noted' }
            : { toolCalls: [{ name: 'research', args: { task: 'x', profile: 'nope' } }] }
        }
        return { text: 'done' }
      }
      return { text: 'a child ran' }
    },
    async ({ llm, open }) => {
      const researcher = createSubagentTool({
        name: 'researcher',
        description: 'Research',
        isolation: 'in-process',
        config: config(llm.baseURL, { model: 'child-model' }),
        profiles: { deep: { description: 'Slow', config: { model: 'strong-model' } } },
      })
      const agent = await open(
        config(llm.baseURL, { model: 'parent-model', tools: { research: researcher } }),
      )
      const { events, onEvent } = collect()
      await agent.run({ input: 'go', onEvent })
      assert.ok(
        !llm.requests.some((r) => r.model !== 'parent-model'),
        'no child model was ever called',
      )
      assert.equal(ofType(events, 'subagent.start').length, 0, 'nothing was announced')
    },
  )
})

test('subagent profiles: a profile that cannot work is refused when the tool is created', () => {
  const make = (extra: Record<string, unknown>) => () =>
    createSubagentTool({
      name: 'r',
      description: 'd',
      config: config('http://unused.test'),
      ...extra,
    } as never)
  // A function would otherwise surface only when that profile is first chosen —
  // possibly hours into a run.
  assert.throws(
    make({
      isolation: 'worker',
      profiles: { p: { description: 'x', config: { getHeaders: () => ({}) } } },
    }),
    /profile "p" config\.getHeaders is a function/,
  )
  assert.doesNotThrow(
    make({
      isolation: 'in-process',
      profiles: { p: { description: 'x', config: { getHeaders: () => ({}) } } },
    }),
    'in-process has no such limit',
  )
  assert.throws(make({ profiles: { p: { description: '  ' } } }), /profile "p" needs a description/)
  assert.throws(make({ profiles: { ' ': { description: 'x' } } }), /non-empty name/)
})

// ── resume ─────────────────────────────────────────────────────────────────
// `resolveResume` is unit-tested for what it REFUSES. What matters to someone
// whose process died mid-run is that a run really CONTINUES: from the saved
// plan and trace, without re-planning and without repeating a finished step.
// The proof is the model's call log, not the final text — a resumed run that
// quietly redid everything would still end with the same answer.

const resumeScript: Script = (req) => {
  switch (stageOf(req)) {
    case 'planner':
      return { text: planJson([{ id: 's1' }, { id: 's2' }, { id: 's3' }]) }
    case 'executor':
      return { text: `did ${stepOf(req)}` }
    case 'replanner':
      return { text: JSON.stringify({ mode: 'continue', reason: 'on track' }) }
    default:
      return { text: 'All three steps done.' }
  }
}

/**
 * A store that behaves like a real one after a crash: it holds the last
 * checkpoint and nothing else, because a dead process never writes
 * `onRunComplete`. `dieAfter` aborts the run right after that many steps have
 * been checkpointed.
 */
const crashingStore = (dieAfter: number) => {
  const saved = new Map<string, IRunSnapshot>()
  const started: string[] = []
  const controller = new AbortController()
  const persistence: IPersistence = {
    onRunStart: (snapshot) => {
      started.push(snapshot.runId)
      saved.set(snapshot.runId, snapshot)
    },
    onStepComplete: (snapshot) => {
      saved.set(snapshot.runId, snapshot)
      if (snapshot.trace.length === dieAfter) controller.abort()
    },
    loadRun: (runId) => saved.get(runId) ?? null,
  }
  return { saved, started, controller, persistence }
}

test('resume: a run interrupted after a step continues from its checkpoint and finishes', async () => {
  await withLlm(resumeScript, async ({ llm, open }) => {
    const { saved, started, controller, persistence } = crashingStore(1)

    const first = await open(config(llm.baseURL, { persistence }))
    await assert.rejects(
      first.run({ input: 'do three things', signal: controller.signal }),
      /abort/i,
      'the first process dies mid-run',
    )
    assert.equal(saved.size, 1)
    const [runId] = [...saved.keys()]
    assert.equal(saved.get(runId)?.trace.length, 1, 'one finished step was checkpointed')

    // A NEW agent, as after a restart, resumes by id. The input passed here is
    // deliberately wrong: the saved one must win, or the run is not the same run.
    const second = await open(config(llm.baseURL, { persistence }))
    const { events, onEvent } = collect()
    const result = await second.run({ input: 'IGNORED', resumeFromRunId: runId, onEvent })

    assert.equal(result.text, 'All three steps done.')
    assert.deepEqual(
      result.trace.map((t) => t.step.id),
      ['s1', 's2', 's3'],
    )
    assert.equal(
      result.trace[0].summary,
      'did s1',
      'step one is carried over from the checkpoint, not produced by a second execution',
    )
    assert.equal(result.iterations, 3, 'the loop counters carry over')

    // The call log is the proof.
    assert.equal(llm.requests.filter((r) => stageOf(r) === 'planner').length, 1, 'never re-planned')
    assert.deepEqual(
      llm.requests.filter((r) => stageOf(r) === 'executor').map(stepOf),
      ['s1', 's2', 's3'],
      'every step ran exactly once across both processes',
    )
    assert.ok(
      !llm.requests.some((r) => userOf(r).includes('IGNORED')),
      'the saved input drove the resumed run, not the one passed to it',
    )
    assert.deepEqual(started, [runId], 'a resumed run does not announce a second start')
    assert.equal(
      ofType(events, 'plan.created').length,
      1,
      'consumers attaching mid-resume see the plan',
    )
    assert.equal(saved.get(runId)?.trace.length, 3, 'the resumed run kept checkpointing')
  })
})

test('resume: the per-run caps still apply across the crash', async () => {
  await withLlm(resumeScript, async ({ llm, open }) => {
    // Two iterations in total for a three-step plan; one is spent before the crash.
    const { saved, controller, persistence } = crashingStore(1)
    const first = await open(config(llm.baseURL, { persistence, maxIterations: 2 }))
    await assert.rejects(
      first.run({ input: 'do three things', signal: controller.signal }),
      /abort/i,
    )
    const [runId] = [...saved.keys()]

    const second = await open(config(llm.baseURL, { persistence, maxIterations: 2 }))
    const result = await second.run({ input: 'unused', resumeFromRunId: runId })

    assert.deepEqual(
      llm.requests.filter((r) => stageOf(r) === 'executor').map(stepOf),
      ['s1', 's2'],
      'only one more step is allowed: the iteration spent before the crash still counts',
    )
    assert.equal(result.iterations, 2)
    assert.equal(result.trace.length, 2)
  })
})
