import assert from 'node:assert/strict'
import test from 'node:test'
import { isMainThread } from 'node:worker_threads'
import { tool, type ToolSet } from 'ai'
import { z } from 'zod'
import {
  createAgent,
  createSubagentTool,
  markReadOnly,
  type AgentEvent,
  type IAgent,
  type IAgentConfig,
  type IRunSnapshot,
  type IToolApprovalRequest,
} from '../src/index.ts'
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
