import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { tool } from 'ai'
import { z } from 'zod'
import {
  createAgent,
  DirSkillStore,
  type AgentEvent,
  type IAgent,
  type IAgentConfig,
  type IToolApprovalRequest,
} from '../src/index.ts'
import {
  startLocalOpenAI,
  systemOf,
  toolNames,
  toolResults,
  userOf,
  type IChatRequest,
  type ILocalOpenAI,
  type Script,
} from './helpers/openai-server.ts'

// Does the notebook actually change what the agent DOES? A problem, a workaround, a lesson, and
// then - in the same session - the lesson in the planner's index and the executor's hands.

type Stage = 'planner' | 'executor' | 'replanner' | 'synthesizer'
const stageOf = (req: IChatRequest): Stage => {
  const system = systemOf(req)
  if (system.includes('You are the Planner')) return 'planner'
  if (system.includes('You are the Replanner')) return 'replanner'
  if (system.includes('You are the Synthesizer')) return 'synthesizer'
  return 'executor'
}
const stepOf = (req: IChatRequest): string =>
  /CURRENT STEP to execute \(id=([^)]+)\)/.exec(userOf(req))?.[1] ?? '?'
const planJson = (steps: string[], skills?: string[]) =>
  JSON.stringify({
    thought: 'Do it.',
    steps: steps.map((id) => ({
      id,
      description: `Step ${id}`,
      expectedOutcome: 'done',
      suggestedTools: [],
    })),
    ...(skills ? { skills } : {}),
  })

const config = (baseURL: string, extra: Partial<IAgentConfig> = {}): IAgentConfig => ({
  clientName: 'learning-test',
  providerType: 'openai-compatible',
  baseURL,
  apiKey: 'not-a-real-key',
  model: 'scripted',
  mcpServers: {},
  maxIterations: 6,
  maxStepsPerTask: 8,
  logLevel: 'none',
  llmMaxRetries: 0,
  ...extra,
})

const withLlm = async (
  script: Script,
  body: (ctx: {
    llm: ILocalOpenAI
    open: (c?: Partial<IAgentConfig>) => Promise<IAgent>
  }) => Promise<void>,
): Promise<void> => {
  const llm = await startLocalOpenAI(script)
  const agents: IAgent[] = []
  try {
    await body({
      llm,
      open: async (extra = {}) => {
        const agent = await createAgent(config(llm.baseURL, extra))
        agents.push(agent)
        return agent
      },
    })
  } finally {
    for (const a of agents) await a.close().catch(() => {})
    await llm.close()
  }
}
const at = (llm: ILocalOpenAI, stage: Stage) => llm.requests.filter((r) => stageOf(r) === stage)
const ofType = <T extends AgentEvent['type']>(events: AgentEvent[], type: T) =>
  events.filter((e): e is Extract<AgentEvent, { type: T }> => e.type === type)

// A tool with a quirk the model has to work around: it rejects "jpeg" and wants "jpg".
const quirky = () => {
  const calls: string[] = []
  const convert = tool({
    description: 'Convert the image to a format',
    inputSchema: z.object({ format: z.string() }),
    execute: async ({ format }) => {
      calls.push(format)
      if (format !== 'jpg') {
        throw new Error(`unsupported format "${format}" - this service calls it "jpg"`)
      }
      return { ok: true, format }
    },
  })
  return { convert, calls }
}

const LESSON = {
  name: 'Image format jpg',
  description: 'When convert rejects the format "jpeg"',
  instructions: 'The convert tool only knows "jpg". Pass format "jpg" - never "jpeg".',
}

// The model's side of the story: hit the quirk, work around it, write it down. Once a lesson
// about the quirk is in the executor's prompt, it just does it right.
const story: Script = (req) => {
  const system = systemOf(req)
  switch (stageOf(req)) {
    case 'planner':
      return {
        text: planJson(
          ['s1'],
          system.includes('image-format-jpg') ? ['image-format-jpg'] : undefined,
        ),
      }
    case 'executor': {
      const done = toolResults(req).length
      if (system.includes('image-format-jpg') && system.includes('A lesson YOU wrote earlier')) {
        return done === 0
          ? { toolCalls: [{ name: 'convert', args: { format: 'jpg' } }] }
          : { text: 'Converted, as I remembered.' }
      }
      if (done === 0) return { toolCalls: [{ name: 'convert', args: { format: 'jpeg' } }] }
      if (done === 1) return { toolCalls: [{ name: 'convert', args: { format: 'jpg' } }] }
      if (done === 2) return { toolCalls: [{ name: 'save_skill', args: LESSON }] }
      return { text: 'Converted after a detour.' }
    }
    case 'replanner':
      return { text: JSON.stringify({ mode: 'continue', reason: 'ok' }) }
    default:
      return { text: 'Done.' }
  }
}

test('learning: a problem solved becomes a skill - and the next run starts from it', async () => {
  await withLlm(story, async ({ llm, open }) => {
    const { convert, calls } = quirky()
    const agent = await open({ tools: { convert }, learning: true })
    const events: AgentEvent[] = []
    await agent.run({ input: 'convert the picture to jpeg', onEvent: (e) => events.push(e) })

    // Run 1: the detour, then the lesson.
    assert.deepEqual(calls, ['jpeg', 'jpg'])
    const learned = ofType(events, 'skill.learned')
    assert.equal(learned.length, 1)
    assert.deepEqual([learned[0].name, learned[0].update], ['image-format-jpg', false])
    assert.deepEqual(agent.listSkills(), [
      { name: 'image-format-jpg', description: LESSON.description, learned: true },
    ])
    assert.equal(agent.listLearnedSkills()[0].origin?.kind, 'learned')

    // Run 2, same session: the planner SEES the lesson in its index and picks it; the executor
    // has it as an active skill, introduced as the agent's own note - and does it right first time.
    const before = llm.requests.length
    calls.length = 0
    await agent.run({ input: 'convert another picture to jpeg' })
    const second = llm.requests.slice(before)
    const planner = second.find((r) => stageOf(r) === 'planner')!
    assert.match(
      systemOf(planner),
      /SKILLS:\n- image-format-jpg: When convert rejects the format "jpeg"/,
    )
    const executor = second.find((r) => stageOf(r) === 'executor')!
    assert.match(
      systemOf(executor),
      /ACTIVE SKILLS[\s\S]*### Skill: image-format-jpg\n\[A lesson YOU wrote earlier \(revision 1\)/,
    )
    assert.match(systemOf(executor), /not an instruction from the user/)
    assert.deepEqual(calls, ['jpg'], 'no detour the second time')
  })
})

test("learning: within ONE run, a lesson written in step 1 is already in step 2's prompt", async () => {
  const script: Script = (req) => {
    const system = systemOf(req)
    switch (stageOf(req)) {
      case 'planner':
        return { text: planJson(['s1', 's2']) }
      case 'executor':
        if (stepOf(req) === 's1') {
          return toolResults(req).length === 0
            ? { toolCalls: [{ name: 'save_skill', args: LESSON }] }
            : { text: 'Wrote it down.' }
        }
        return {
          text: system.includes('- image-format-jpg:')
            ? 'Saw the lesson in my skills.'
            : 'No lesson in sight.',
        }
      case 'replanner':
        return { text: JSON.stringify({ mode: 'continue', reason: 'ok' }) }
      default:
        return { text: 'Done.' }
    }
  }
  await withLlm(script, async ({ llm, open }) => {
    const agent = await open({ learning: true })
    const result = await agent.run({ input: 'two steps' })
    assert.equal(result.trace[1].summary, 'Saw the lesson in my skills.')
    // The tools exist from the start even though no skill was configured.
    assert.ok(toolNames(at(llm, 'executor')[0]).includes('load_skill'))
  })
})

test('learning off (the default): no notebook tools, and not a word about learning in the prompts', async () => {
  await withLlm(story, async ({ llm, open }) => {
    const { convert } = quirky()
    const agent = await open({ tools: { convert } })
    await agent.run({ input: 'convert the picture to jpeg' })
    for (const req of at(llm, 'executor')) {
      assert.ok(!toolNames(req).includes('save_skill') && !toolNames(req).includes('forget_skill'))
      assert.doesNotMatch(systemOf(req), /LEARNING:|notebook/)
    }
    assert.deepEqual(agent.listLearnedSkills(), [])
    assert.equal(await agent.forgetSkill('anything'), false)
  })
})

test('learning on: the executor is told to keep a notebook - and where to look when stuck', async () => {
  await withLlm(story, async ({ llm, open }) => {
    const { convert } = quirky()
    await (await open({ tools: { convert }, learning: true })).run({ input: 'convert' })
    const system = systemOf(at(llm, 'executor')[0])
    assert.match(system, /LEARNING:\nYou keep a notebook of lessons/)
    assert.match(system, /call save_skill once/)
    assert.doesNotMatch(system, /web_fetch/, 'no fetch tool, so it is not suggested')

    const llm2Before = llm.requests.length
    const withFetch = await open({
      tools: { convert },
      learning: true,
      egress: { allow: ['docs.example.com'] },
    })
    await withFetch.run({ input: 'convert' })
    const fetchSystem = systemOf(
      llm.requests.slice(llm2Before).find((r) => stageOf(r) === 'executor')!,
    )
    assert.match(fetchSystem, /look for it before giving up \(web_fetch can read documentation\)/)

    // nudge: false keeps the tools but drops the guidance.
    const quiet = llm.requests.length
    await (await open({ tools: { convert }, learning: { nudge: false } })).run({ input: 'convert' })
    const quietExec = llm.requests.slice(quiet).find((r) => stageOf(r) === 'executor')!
    assert.ok(toolNames(quietExec).includes('save_skill'))
    assert.doesNotMatch(systemOf(quietExec), /LEARNING:/)
  })
})

test('learning and the approval gate: saving is a write - a human can say no, and nothing is kept', async () => {
  await withLlm(story, async ({ open }) => {
    const { convert } = quirky()
    const asked: IToolApprovalRequest[] = []
    const agent = await open({
      tools: { convert },
      learning: true,
      toolApproval: {
        mode: 'ask-writes',
        onRequest: (req) => {
          asked.push(req)
          // The human lets the conversion through and refuses to let it remember.
          return req.toolName !== 'save_skill'
        },
      },
    })
    const events: AgentEvent[] = []
    const result = await agent.run({ input: 'convert', onEvent: (e) => events.push(e) })
    const save = asked.find((r) => r.toolName === 'save_skill')
    assert.ok(save, 'the human was asked')
    assert.equal((save.input as { name: string }).name, 'Image format jpg')
    assert.deepEqual(agent.listLearnedSkills(), [])
    assert.equal(ofType(events, 'skill.learned').length, 0)
    const call = result.trace[0].toolCalls.find((c) => c.name === 'save_skill')
    assert.equal(call?.ok, false, 'the model was told no')
  })
})

test('learning: a credential in a lesson is refused to the model, and never stored', async () => {
  const leaky: Script = (req) => {
    switch (stageOf(req)) {
      case 'planner':
        return { text: planJson(['s1']) }
      case 'executor':
        return toolResults(req).length === 0
          ? {
              toolCalls: [
                {
                  name: 'save_skill',
                  args: {
                    ...LESSON,
                    instructions: `Call the API with the key sk-${'a1B2c3D4e5F6g7H8i9J0'} in the header.`,
                  },
                },
              ],
            }
          : { text: 'ok' }
      case 'replanner':
        return { text: JSON.stringify({ mode: 'continue', reason: 'ok' }) }
      default:
        return { text: 'Done.' }
    }
  }
  await withLlm(leaky, async ({ llm, open }) => {
    const agent = await open({ learning: true })
    const result = await agent.run({ input: 'x' })
    const call = result.trace[0].toolCalls[0]
    assert.equal(call.ok, false)
    assert.match(String((call.output as Error).message), /looks like it contains an API key/)
    assert.deepEqual(agent.listLearnedSkills(), [])
    // The model saw the refusal, not an echo of the key.
    const next = at(llm, 'executor')[1]
    assert.ok(!toolResults(next).join(' ').includes('a1B2c3D4'))
  })
})

test('learning with a folder: lessons outlive the session as SKILL.md files, and the next agent starts with them', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'notebook-'))
  try {
    await withLlm(story, async ({ llm, open }) => {
      const { convert } = quirky()
      const first = await open({ tools: { convert }, learning: { store: new DirSkillStore(dir) } })
      await first.run({ input: 'convert the picture to jpeg' })
      const md = await readFile(path.join(dir, 'image-format-jpg', 'SKILL.md'), 'utf8')
      assert.match(md, /Pass format "jpg" - never "jpeg"/)

      // A brand-new agent over the same folder: the lesson is there from the first call.
      const second = await open({ tools: { convert }, learning: { store: new DirSkillStore(dir) } })
      assert.equal(second.listLearnedSkills()[0]?.name, 'image-format-jpg')
      assert.equal(second.listLearnedSkills()[0]?.origin?.revision, 1)
      const before = llm.requests.length
      const { convert: c2, calls } = quirky()
      void c2
      await second.run({ input: 'convert yet another picture' })
      assert.match(
        systemOf(llm.requests.slice(before).find((r) => stageOf(r) === 'planner')!),
        /- image-format-jpg:/,
      )
      void calls

      // Forgetting removes the file too.
      assert.equal(await second.forgetSkill('image-format-jpg'), true)
      await assert.rejects(readFile(path.join(dir, 'image-format-jpg', 'SKILL.md')))
      assert.deepEqual(second.listSkills(), [])
    })
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('learning: pages read during the run are recorded on the lesson - by the harness, not the model', async () => {
  const hits: string[] = []
  const page: Server = createServer((req, res) => {
    hits.push(req.url ?? '')
    res
      .writeHead(200, { 'content-type': 'text/plain' })
      .end('The service calls jpeg "jpg". Use jpg.')
  })
  await new Promise<void>((r) => page.listen(0, '127.0.0.1', r))
  const port = (page.address() as AddressInfo).port
  const script: Script = (req) => {
    switch (stageOf(req)) {
      case 'planner':
        return { text: planJson(['s1']) }
      case 'executor': {
        const n = toolResults(req).length
        if (n === 0)
          return {
            toolCalls: [
              { name: 'web_fetch', args: { url: `http://127.0.0.1:${port}/docs?session=abc` } },
            ],
          }
        if (n === 1)
          return { toolCalls: [{ name: 'save_skill', args: { ...LESSON, sources: ['the docs'] } }] }
        return { text: 'ok' }
      }
      case 'replanner':
        return { text: JSON.stringify({ mode: 'continue', reason: 'ok' }) }
      default:
        return { text: 'Done.' }
    }
  }
  try {
    await withLlm(script, async ({ open }) => {
      const agent = await open({
        learning: true,
        egress: { allowPrivateNetwork: true, protocols: ['http'], ports: [port] },
      })
      await agent.run({ input: 'find out and remember' })
      const origin = agent.listLearnedSkills()[0].origin
      assert.deepEqual(origin?.sources, ['the docs'])
      assert.deepEqual(
        origin?.fetched,
        [`http://127.0.0.1:${port}/docs`],
        'where it read, query string cut off',
      )
      assert.equal(hits.length, 1)
    })
  } finally {
    await new Promise<void>((r) => {
      page.closeAllConnections()
      page.close(() => r())
    })
  }
})
