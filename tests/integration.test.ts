import assert from 'node:assert/strict'
import test from 'node:test'
import { createAgent, type IAgent } from '../src/index.ts'
import { createNodeOAuthProvider, finishMcpOAuth, MemoryOAuthStore } from '../src/mcp-oauth.ts'
import { startLocalMcp } from './helpers/mcp-server.ts'
import {
  hasToolResult,
  startLocalOpenAI,
  type IChatRequest,
  type IScriptedReply,
  type Script,
} from './helpers/openai-server.ts'

type Agent = IAgent

// End-to-end over real sockets: a scripted OpenAI-compatible endpoint, a real
// MCP server (SDK implementation, StreamableHTTP), and a real authorization
// server. Nothing is stubbed inside the agent — the provider package, the
// transport, the OAuth machinery and the loop all run for real. No API key is
// involved, so this belongs in ordinary CI rather than a nightly job.

const TOOL = 'files__echo'

/**
 * One scripted answer per agent stage. Matching on the system prompt rather
 * than on call order keeps the test readable and lets a stage retry without
 * desynchronising the script.
 */
const stageScript = (opts: { toolArgs?: unknown } = {}) => {
  // Two steps on purpose: the replanner never runs after the LAST planned
  // step, so a single-step plan would quietly skip that stage.
  const plan = {
    thought: 'Echo the text through the MCP server.',
    steps: [
      {
        id: 's1',
        description: 'Echo the text',
        expectedOutcome: 'The server echoed the text back',
        suggestedTools: [TOOL],
      },
      {
        id: 's2',
        description: 'Report what came back',
        expectedOutcome: 'The user sees the echoed text',
        suggestedTools: [],
      },
    ],
  }

  return (req: IChatRequest): IScriptedReply => {
    const system = req.messages.find((m) => m.role === 'system')?.content
    const prompt = typeof system === 'string' ? system : JSON.stringify(system ?? '')

    if (prompt.includes('You are the Planner')) return { text: JSON.stringify(plan) }
    if (prompt.includes('You are the Replanner')) {
      return { text: JSON.stringify({ mode: 'finish', reason: 'The step succeeded.' }) }
    }
    if (prompt.includes('You are the Synthesizer')) return { text: 'Echoed: hello' }
    // Executor: call the tool first, then report on the result it got back.
    if (hasToolResult(req)) return { text: 'Called the echo tool and got the text back.' }
    return { toolCalls: [{ name: TOOL, args: opts.toolArgs ?? { text: 'hello' } }] }
  }
}

const baseConfig = (baseURL: string, url: string, extra: Record<string, unknown> = {}) => ({
  clientName: 'agent-integration-test',
  providerType: 'openai-compatible' as const,
  baseURL,
  apiKey: 'not-a-real-key',
  model: 'scripted',
  mcpServers: { files: { url, ...extra } },
  maxIterations: 3,
  maxStepsPerTask: 4,
  // Run the replanner on every step, so this covers all four stages rather
  // than skipping the one that only fires on failure.
  replanAfter: 'always' as const,
  logLevel: 'none' as const,
})

/**
 * Servers and agents are torn down even when an assertion throws — a leaked
 * socket keeps the whole test file alive until the runner's timeout, which
 * hides the real failure behind a timeout report.
 */
const withServers = async (
  requireAuth: boolean,
  script: Script,
  body: (ctx: {
    mcp: Awaited<ReturnType<typeof startLocalMcp>>
    llm: Awaited<ReturnType<typeof startLocalOpenAI>>
    open: (config: Record<string, unknown>) => Promise<Agent>
  }) => Promise<void>,
): Promise<void> => {
  const mcp = await startLocalMcp({ requireAuth })
  const llm = await startLocalOpenAI(script)
  const agents: Agent[] = []
  try {
    await body({
      mcp,
      llm,
      open: async (config) => {
        const agent = (await createAgent(config as never)) as Agent
        agents.push(agent)
        return agent
      },
    })
  } finally {
    for (const agent of agents) await agent.close().catch(() => {})
    await llm.close()
    await mcp.close()
  }
}

test('plan → execute → replan → synthesize, driving a real MCP server over HTTP', async () => {
  await withServers(false, stageScript(), async ({ mcp, llm, open }) => {
    const agent = await open(baseConfig(llm.baseURL, mcp.url))
    assert.deepEqual(
      agent
        .listTools()
        .map((t) => t.name)
        .sort(),
      ['files__boom', 'files__echo', 'files__secret'],
      'the tool list came from the live server',
    )

    const result = await agent.run({ input: 'Echo "hello" for me' })

    assert.equal(result.text, 'Echoed: hello')
    assert.equal(result.plan.steps.length, 2)
    // The replanner said "finish" after the first step, so the second was
    // never executed — that decision is part of what this covers.
    assert.equal(result.trace.length, 1)
    assert.deepEqual(mcp.calls, [{ name: 'echo', args: { text: 'hello' } }])
    const call = result.trace[0].toolCalls[0]
    assert.equal(call.name, TOOL)
    assert.equal(call.ok, true)
    assert.equal(call.output, 'echo:hello')
    assert.ok(result.usage.totalTokens > 0, 'usage was accumulated from the provider')

    // All four stages really went over the wire, in order.
    const systems = llm.requests.map((r) =>
      String(r.messages.find((m) => m.role === 'system')?.content ?? ''),
    )
    assert.ok(systems[0].includes('You are the Planner'))
    assert.ok(systems.some((s) => s.includes('You are the Executor')))
    assert.ok(systems.some((s) => s.includes('You are the Replanner')))
    assert.ok(systems.at(-1)?.includes('You are the Synthesizer'))
  })
})

test('a tool that reports isError is recorded as a failed call', async () => {
  const script: Script = (req) => {
    const system = req.messages.find((m) => m.role === 'system')?.content
    const prompt = typeof system === 'string' ? system : ''
    if (prompt.includes('You are the Planner')) {
      return {
        text: JSON.stringify({
          thought: 'Call the failing tool.',
          steps: [
            { id: 's1', description: 'Fail', expectedOutcome: 'An error', suggestedTools: [] },
          ],
        }),
      }
    }
    if (prompt.includes('You are the Replanner')) {
      return { text: JSON.stringify({ mode: 'finish', reason: 'Nothing more to do.' }) }
    }
    if (prompt.includes('You are the Synthesizer')) return { text: 'It failed.' }
    if (hasToolResult(req)) return { text: 'The tool reported an error.' }
    return { toolCalls: [{ name: 'files__boom', args: {} }] }
  }

  await withServers(false, script, async ({ llm, mcp, open }) => {
    const agent = await open(baseConfig(llm.baseURL, mcp.url))
    const result = await agent.run({ input: 'Trigger the failure' })

    const call = result.trace[0].toolCalls[0]
    assert.equal(call.name, 'files__boom')
    // The server answered 200 with isError — the agent must still treat it as
    // a failed call, or the replanner never learns the step went wrong.
    assert.equal(call.ok, false)
    assert.match(String(JSON.parse(JSON.stringify(call.output))), /kaboom/)
  })
})

test('OAuth: authorize once, then run against the protected server', async () => {
  await withServers(true, stageScript(), async ({ mcp, llm, open }) => {
    const prompts: URL[] = []
    const provider = createNodeOAuthProvider({
      serverUrl: mcp.url,
      redirectUrl: 'http://127.0.0.1:9999/callback',
      store: new MemoryOAuthStore(),
      onAuthorizationUrl: (url) => {
        prompts.push(url)
      },
    })

    // First contact: the server challenges, the client registers itself
    // dynamically and asks for an authorization.
    const unauthorized = await open(baseConfig(llm.baseURL, mcp.url, { authProvider: provider }))
    assert.deepEqual(unauthorized.listTools(), [], 'no tools before authorization')
    assert.equal(mcp.registrations(), 1, 'dynamic client registration ran')
    assert.equal(prompts.length, 1)

    // The operator visits the URL and comes back with a code.
    await finishMcpOAuth(provider, {
      code: 'auth-code-1',
      state: prompts[0].searchParams.get('state') ?? undefined,
    })

    const agent = await open(baseConfig(llm.baseURL, mcp.url, { authProvider: provider }))
    assert.equal(agent.listTools().length, 3, 'the tools arrived once authorized')
    const result = await agent.run({ input: 'Echo "hello" for me' })
    assert.equal(result.text, 'Echoed: hello')
    assert.deepEqual(mcp.calls, [{ name: 'echo', args: { text: 'hello' } }])
  })
})

test('OAuth: a token that dies mid-run is refreshed and the tool call retried', async () => {
  await withServers(true, stageScript(), async ({ mcp, llm, open }) => {
    const prompts: URL[] = []
    const provider = createNodeOAuthProvider({
      serverUrl: mcp.url,
      redirectUrl: 'http://127.0.0.1:9999/callback',
      store: new MemoryOAuthStore(),
      onAuthorizationUrl: (url) => {
        prompts.push(url)
      },
    })

    await open(baseConfig(llm.baseURL, mcp.url, { authProvider: provider }))
    await finishMcpOAuth(provider, {
      code: 'auth-code-1',
      state: prompts[0].searchParams.get('state') ?? undefined,
    })
    const agent = await open(baseConfig(llm.baseURL, mcp.url, { authProvider: provider }))
    assert.equal(agent.listTools().length, 3)

    // The access token stops working after the connection is up — the case a
    // static Authorization header can never recover from.
    const before = mcp.grants().length
    mcp.validTokens.clear()

    const result = await agent.run({ input: 'Echo "hello" for me' })

    assert.equal(result.text, 'Echoed: hello', 'the run survived the expiry')
    assert.deepEqual(mcp.calls, [{ name: 'echo', args: { text: 'hello' } }])
    assert.ok(
      mcp.grants().slice(before).includes('refresh_token'),
      'the client refreshed rather than failing the call',
    )
    assert.equal(prompts.length, 1, 'no second authorization was demanded')
  })
})
