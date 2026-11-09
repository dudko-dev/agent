import assert from 'node:assert/strict'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import test from 'node:test'
import { tool } from 'ai'
import { z } from 'zod'
import { createAgent, type AgentEvent, type IAgent, type IAgentConfig } from '../src/index.ts'
import {
  hasToolResult,
  startLocalOpenAI,
  systemOf,
  toolNames,
  toolResults,
  type IChatRequest,
  type ILocalOpenAI,
  type Script,
} from './helpers/openai-server.ts'

// The whole stack: the agent, a model that asks to read a URL, the egress policy between them,
// and a "private" server that must stay private unless the operator opened the door.

type Stage = 'planner' | 'executor' | 'replanner' | 'synthesizer'
const stageOf = (req: IChatRequest): Stage => {
  const system = systemOf(req)
  if (system.includes('You are the Planner')) return 'planner'
  if (system.includes('You are the Replanner')) return 'replanner'
  if (system.includes('You are the Synthesizer')) return 'synthesizer'
  return 'executor'
}
const planJson = () =>
  JSON.stringify({
    thought: 'Read the page.',
    steps: [{ id: 's1', description: 'Read it', expectedOutcome: 'text', suggestedTools: [] }],
  })

interface IInternal {
  port: number
  hits: string[]
  close: () => Promise<void>
}
// The "internal service": something on loopback the model must not be able to reach by default.
const internal = async (): Promise<IInternal> => {
  const hits: string[] = []
  const server: Server = createServer((req, res) => {
    hits.push(req.url ?? '')
    res
      .writeHead(200, { 'content-type': 'text/html' })
      .end('<html><title>Internal</title><body>the launch code is 0000</body></html>')
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  return {
    port: (server.address() as AddressInfo).port,
    hits,
    close: () =>
      new Promise<void>((r) => {
        server.closeAllConnections()
        server.close(() => r())
      }),
  }
}

const config = (baseURL: string, extra: Partial<IAgentConfig> = {}): IAgentConfig => ({
  clientName: 'egress-test',
  providerType: 'openai-compatible',
  baseURL,
  apiKey: 'not-a-real-key',
  model: 'scripted',
  mcpServers: {},
  maxIterations: 4,
  maxStepsPerTask: 4,
  logLevel: 'none',
  llmMaxRetries: 0,
  ...extra,
})

const withStack = async (
  url: (port: number) => string,
  body: (ctx: {
    llm: ILocalOpenAI
    srv: IInternal
    open: (c?: Partial<IAgentConfig>) => Promise<IAgent>
  }) => Promise<void>,
): Promise<void> => {
  const srv = await internal()
  const script: Script = (req) => {
    switch (stageOf(req)) {
      case 'planner':
        return { text: planJson() }
      case 'executor':
        return hasToolResult(req)
          ? { text: 'I read it.' }
          : toolNames(req).includes('web_fetch')
            ? { toolCalls: [{ name: 'web_fetch', args: { url: url(srv.port) } }] }
            : { text: 'I have no way to read it.' }
      case 'replanner':
        return { text: JSON.stringify({ mode: 'continue', reason: 'ok' }) }
      default:
        return { text: 'Done.' }
    }
  }
  const llm = await startLocalOpenAI(script)
  const agents: IAgent[] = []
  try {
    await body({
      llm,
      srv,
      open: async (extra = {}) => {
        const agent = await createAgent(config(llm.baseURL, extra))
        agents.push(agent)
        return agent
      },
    })
  } finally {
    for (const a of agents) await a.close().catch(() => {})
    await llm.close()
    await srv.close()
  }
}

const executorRequests = (llm: ILocalOpenAI) =>
  llm.requests.filter((r) => stageOf(r) === 'executor')
const local = (port: number) => `http://127.0.0.1:${port}/secret?key=abc`

test('egress off (the default): the model is not even offered a way to fetch', async () => {
  await withStack(local, async ({ llm, srv, open }) => {
    const agent = await open()
    const result = await agent.run({ input: 'read the page' })
    assert.ok(executorRequests(llm).every((r) => !toolNames(r).includes('web_fetch')))
    assert.equal(result.trace[0].toolCalls.length, 0)
    assert.equal(srv.hits.length, 0)
  })
})

test('egress on with defaults: the model asks for localhost and is refused - the service never sees it', async () => {
  await withStack(local, async ({ llm, srv, open }) => {
    const agent = await open({ egress: true })
    const events: AgentEvent[] = []
    const result = await agent.run({ input: 'read the page', onEvent: (e) => events.push(e) })
    assert.ok(toolNames(executorRequests(llm)[0]).includes('web_fetch'), 'the tool is offered')

    const call = result.trace[0].toolCalls[0]
    assert.equal(call.name, 'web_fetch')
    assert.equal(call.ok, false)
    assert.match(String((call.output as Error).message), /egress denied/)
    assert.equal(srv.hits.length, 0, 'the internal service was never contacted')

    const e = events.find((x) => x.type === 'egress.request')
    assert.ok(e?.type === 'egress.request')
    assert.equal(e.allowed, false)
    assert.ok(
      !JSON.stringify(events.filter((x) => x.type === 'egress.request')).includes('abc'),
      'no query string in the log',
    )
    // The run went on: the model was told, and answered.
    assert.equal(result.text, 'Done.')
    // What the model saw back is the refusal, not the page.
    const next = executorRequests(llm)[1]
    assert.ok(!toolResults(next).join(' ').includes('launch code'))
  })
})

test('egress opened to private networks on purpose: the page comes back as data for the model', async () => {
  await withStack(local, async ({ llm, srv, open }) => {
    const agent = await open({
      egress: { allowPrivateNetwork: true, protocols: ['http'], ports: [srv.port] },
    })
    const events: AgentEvent[] = []
    const result = await agent.run({ input: 'read the page', onEvent: (e) => events.push(e) })
    const call = result.trace[0].toolCalls[0]
    assert.equal(call.ok, true)
    assert.equal((call.output as { text: string }).text, 'the launch code is 0000')
    assert.equal((call.output as { untrusted: boolean }).untrusted, true)
    assert.equal(srv.hits.length, 1)
    assert.ok(toolResults(executorRequests(llm)[1]).join(' ').includes('launch code'))
    const e = events.find((x) => x.type === 'egress.request')
    assert.ok(e?.type === 'egress.request' && e.allowed && e.status === 200)
  })
})

test('egress allow list: a host outside it is refused even though the network would allow it', async () => {
  await withStack(local, async ({ srv, open }) => {
    const agent = await open({
      egress: {
        allow: ['docs.example.com'],
        allowPrivateNetwork: true,
        protocols: ['http'],
        ports: [srv.port],
      },
    })
    const result = await agent.run({ input: 'read the page' })
    const call = result.trace[0].toolCalls[0]
    assert.equal(call.ok, false)
    assert.match(String((call.output as Error).message), /not on the allow list/)
    assert.equal(srv.hits.length, 0)
  })
})

test('egress and the approval gate: an open fetch asks like a write; a named-host one is read-only', async () => {
  const policy = (port: number) => ({
    allowPrivateNetwork: true,
    protocols: ['http' as const],
    ports: [port],
  })
  // Open internet + read-only mode: the gate refuses the call (it is not a read).
  await withStack(local, async ({ srv, open }) => {
    const agent = await open({
      toolApproval: { mode: 'read-only' },
      egress: policy(srv.port),
    })
    const result = await agent.run({ input: 'read the page' })
    const call = result.trace[0].toolCalls[0]
    assert.equal(call.ok, false)
    assert.match(String((call.output as Error).message), /denied|read-only/i)
    assert.equal(srv.hits.length, 0)
  })
  // The same under read-only mode, but the operator named the host: it counts as a read.
  await withStack(local, async ({ srv, open }) => {
    const agent = await open({
      toolApproval: { mode: 'read-only' },
      egress: { ...policy(srv.port), allow: ['127.0.0.1'] },
    })
    const result = await agent.run({ input: 'read the page' })
    assert.equal(result.trace[0].toolCalls[0].ok, true)
    assert.equal(srv.hits.length, 1)
  })
})

test('a tool of your own named web_fetch wins over the built-in one', async () => {
  await withStack(local, async ({ srv, open }) => {
    const mine = tool({
      description: 'My fetch',
      inputSchema: z.object({ url: z.string() }),
      execute: async () => ({ text: 'from my own tool' }),
    })
    const agent = await open({ egress: true, tools: { web_fetch: mine } })
    const result = await agent.run({ input: 'read the page' })
    assert.deepEqual(result.trace[0].toolCalls[0].output, { text: 'from my own tool' })
    assert.equal(srv.hits.length, 0)
  })
})
