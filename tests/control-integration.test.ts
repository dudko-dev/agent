import assert from 'node:assert/strict'
import test from 'node:test'
import { tool } from 'ai'
import { z } from 'zod'
import {
  createAgent,
  createRunControl,
  createSubagentTool,
  type AgentEvent,
  type IAgent,
  type IAgentConfig,
  type IRunSnapshot,
  type RunControl,
} from '../src/index.ts'
import {
  hasToolResult,
  startLocalOpenAI,
  systemOf,
  toolResults,
  userOf,
  type IChatRequest,
  type ILocalOpenAI,
  type Script,
} from './helpers/openai-server.ts'

// Steering a run that is already going, end to end over real sockets: a scripted
// OpenAI-compatible endpoint (the real provider package, the real wire format).
// What matters is what the MODEL is shown and when - so the assertions read each request
// the endpoint received, not the final text: a run that quietly ignored the message would
// still end with a fine-looking answer.

type Stage = 'planner' | 'executor' | 'replanner' | 'synthesizer'
const stageOf = (req: IChatRequest): Stage => {
  const system = systemOf(req)
  if (system.includes('You are the Planner')) return 'planner'
  if (system.includes('You are the Replanner')) return 'replanner'
  if (system.includes('You are the Synthesizer')) return 'synthesizer'
  return 'executor'
}
const at = (llm: ILocalOpenAI, stage: Stage): IChatRequest[] =>
  llm.requests.filter((r) => stageOf(r) === stage)
const stepOf = (req: IChatRequest): string =>
  /CURRENT STEP to execute \(id=([^)]+)\)/.exec(userOf(req))?.[1] ?? '?'

const stepJson = (id: string) => ({
  id,
  description: `Step ${id}`,
  expectedOutcome: `${id} done`,
  suggestedTools: [] as string[],
})
const planJson = (...ids: string[]) =>
  JSON.stringify({ thought: 'Do it step by step.', steps: ids.map(stepJson) })
const decision = (mode: 'continue' | 'finish' | 'revise', ...newSteps: string[]) =>
  JSON.stringify({
    mode,
    reason: `because ${mode}`,
    ...(mode === 'revise'
      ? { newPlan: { thought: 'revised', steps: newSteps.map(stepJson) } }
      : {}),
  })

const config = (baseURL: string, extra: Partial<IAgentConfig> = {}): IAgentConfig => ({
  clientName: 'control-test',
  providerType: 'openai-compatible',
  baseURL,
  apiKey: 'not-a-real-key',
  model: 'scripted',
  mcpServers: {},
  maxIterations: 6,
  maxStepsPerTask: 6,
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

const textOf = (content: unknown): string =>
  typeof content === 'string'
    ? content
    : Array.isArray(content)
      ? content.map((p: { text?: string }) => p.text ?? '').join('')
      : JSON.stringify(content ?? '')
const roles = (req: IChatRequest): string[] =>
  req.messages.filter((m) => m.role !== 'system').map((m) => m.role)
const MID_STEP = 'NEW MESSAGE FROM THE USER'
const injected = (req: IChatRequest): number =>
  req.messages.filter((m) => m.role === 'user' && textOf(m.content).includes(MID_STEP)).length
const wire = (req: IChatRequest): string => req.messages.map((m) => textOf(m.content)).join('\n')

const echoTool = (onCall?: (n: number) => void) => {
  let n = 0
  return tool({
    description: 'Fetch a thing',
    inputSchema: z.object({}),
    execute: async () => {
      onCall?.((n += 1))
      return { ok: true }
    },
  })
}

// ── the handle itself ────────────────────────────────────────────────────────

test('control: refuses what cannot be delivered, keeps order', () => {
  const c = createRunControl()
  assert.equal(c.send(''), false)
  assert.equal(c.send('   \n'), false)
  assert.equal(c.send(undefined as never), false)
  assert.equal(c.send('  first  '), true, 'trimmed')
  assert.equal(c.send('second'), true)
  assert.deepEqual(c.pending(), ['first', 'second'])
  assert.deepEqual(c.subagents(), [])
  assert.equal(c.stopSubagent('nope'), false, 'nothing by that id is running')
})

test('control: a hand-made object is refused loudly, before anything is spent', async () => {
  await withLlm(
    () => ({ text: planJson('s1') }),
    async ({ llm, open }) => {
      const agent = await open()
      const fake = {
        send: () => true,
        pending: () => [],
        subagents: () => [],
        stopSubagent: () => false,
      }
      await assert.rejects(agent.run({ input: 'go', control: fake }), /createRunControl/)
      assert.equal(llm.requests.length, 0, 'no model call was made')
    },
  )
})

// ── delivery inside a step ───────────────────────────────────────────────────

test('control: a message sent during a tool call reaches the model on its next round, once', async () => {
  const control = createRunControl()
  const script: Script = (req) => {
    switch (stageOf(req)) {
      case 'planner':
        return { text: planJson('s1') }
      case 'executor':
        // Round 1 and 2 call the tool, round 3 answers.
        return toolResults(req).length < 2
          ? { toolCalls: [{ name: 'fetch', args: {} }] }
          : { text: 'fetched' }
      case 'replanner':
        return { text: decision('continue') }
      default:
        return { text: 'Report fetched.' }
    }
  }
  await withLlm(script, async ({ llm, open }) => {
    const fetch = echoTool((n) => {
      if (n === 1) control.send('use the staging database')
    })
    const agent = await open({ tools: { fetch } })
    const { events, onEvent } = collect()
    const result = await agent.run({ input: 'get the report', control, onEvent })

    const exec = at(llm, 'executor')
    assert.equal(exec.length, 3)
    assert.equal(injected(exec[0]), 0, 'round 1 was made before anyone spoke')
    assert.equal(injected(exec[1]), 1, 'round 2 is the first call after the tool ran')
    assert.equal(injected(exec[2]), 1, 'round 3 still has it - and once, not again')
    // After the tool result, as its own turn: the order providers need (tool_result first).
    assert.deepEqual(roles(exec[1]), ['user', 'assistant', 'tool', 'user'])
    assert.match(textOf(exec[1].messages.at(-1)?.content), /use the staging database/)

    assert.deepEqual(
      events
        .filter((e) => e.type === 'message.queued' || e.type === 'message.delivered')
        .map((e) => [e.type, e.type === 'message.delivered' ? e.at : undefined]),
      [
        ['message.queued', undefined],
        ['message.delivered', 'round'],
      ],
    )
    assert.deepEqual(result.undelivered, [])
    // The only step ended with the message unweighed: the replanner looks at it, even
    // though a last step normally goes straight to the answer.
    const replanner = at(llm, 'replanner')
    assert.equal(replanner.length, 1)
    assert.match(userOf(replanner[0]), /Messages from the user/)
    assert.match(userOf(replanner[0]), /use the staging database\s+\[NEW/)
    const d = ofType(events, 'replan.decision')[0]
    assert.equal(d.cause, 'user-message')
  })
})

test('control: a step that ends without another round hands the message to the replanner', async () => {
  const control = createRunControl()
  const script: Script = (req) => {
    switch (stageOf(req)) {
      case 'planner':
        return { text: planJson('a', 'b') }
      case 'executor':
        return { text: `did ${stepOf(req)}` }
      case 'replanner':
        return { text: decision('continue') }
      default:
        return { text: 'done' }
    }
  }
  await withLlm(script, async ({ llm, open }) => {
    const agent = await open()
    const { events, onEvent } = collect()
    const result = await agent.run({
      input: 'go',
      control,
      onEvent: (e) => {
        onEvent(e)
        if (e.type === 'step.complete' && e.step.id === 'a') control.send('skip the report')
      },
    })
    const delivered = ofType(events, 'message.delivered')[0]
    assert.equal(delivered.at, 'step')
    assert.equal(ofType(events, 'replan.decision')[0].cause, 'user-message')
    // The replanner chose to continue; step b's executor still knows what the user said.
    const second = at(llm, 'executor')[1]
    assert.match(userOf(second), /Messages from the user/)
    assert.match(userOf(second), /skip the report/)
    assert.equal(result.trace.length, 2)
  })
})

test('control: a message can revise the plan; it ignores maxRevisions and is not counted', async () => {
  const control = createRunControl()
  const script: Script = (req) => {
    switch (stageOf(req)) {
      case 'planner':
        return { text: planJson('a', 'b', 'c') }
      case 'executor':
        // Step "b2" (the revised step) cannot be done: the failure rule replans on it.
        return { text: stepOf(req) === 'b2' ? 'cannot [BLOCKER]' : `did ${stepOf(req)}` }
      case 'replanner':
        // The first look is the one with the NEW message; the second is the failure rule's.
        return {
          text: userOf(req).includes('[NEW -')
            ? decision('revise', 'b2', 'c2')
            : decision('revise', 'b3'),
        }
      default:
        return { text: 'done' }
    }
  }
  await withLlm(script, async ({ llm, open }) => {
    // One revision allowed in all. The user's message takes none of it.
    const agent = await open({ maxRevisions: 1 })
    await agent.run({
      input: 'go',
      control,
      onEvent: (e) => {
        if (e.type === 'step.complete' && e.step.id === 'a') control.send('use metric')
      },
    })
    assert.deepEqual(
      at(llm, 'executor').map(stepOf),
      ['a', 'b2', 'b3'],
      'the failure after the user-forced revise was still allowed its own revision',
    )
  })
})

test('control: a user-forced revise is allowed even with maxRevisions: 0', async () => {
  const control = createRunControl()
  const script: Script = (req) => {
    switch (stageOf(req)) {
      case 'planner':
        return { text: planJson('a', 'b') }
      case 'executor':
        return { text: `did ${stepOf(req)}` }
      case 'replanner':
        return { text: decision('revise', 'b2') }
      default:
        return { text: 'done' }
    }
  }
  await withLlm(script, async ({ llm, open }) => {
    const agent = await open({ maxRevisions: 0 })
    const { events, onEvent } = collect()
    await agent.run({
      input: 'go',
      control,
      onEvent: (e) => {
        onEvent(e)
        if (e.type === 'step.complete' && e.step.id === 'a') control.send('use metric')
      },
    })
    assert.deepEqual(at(llm, 'executor').map(stepOf), ['a', 'b2'])
    assert.equal(ofType(events, 'revisions.exceeded').length, 0)
  })
})

test('control: a message on the LAST step still reaches the replanner, which can add work', async () => {
  const control = createRunControl()
  const script: Script = (req) => {
    switch (stageOf(req)) {
      case 'planner':
        return { text: planJson('only') }
      case 'executor':
        return { text: `did ${stepOf(req)}` }
      case 'replanner':
        return { text: decision('revise', 'extra') }
      default:
        return { text: 'done' }
    }
  }
  await withLlm(script, async ({ llm, open }) => {
    const agent = await open()
    const { events, onEvent } = collect()
    const result = await agent.run({
      input: 'go',
      control,
      onEvent: (e) => {
        onEvent(e)
        if (e.type === 'step.complete' && e.step.id === 'only') control.send('also check the logs')
      },
    })
    assert.match(userOf(at(llm, 'replanner')[0]), /There is no next step/)
    assert.deepEqual(at(llm, 'executor').map(stepOf), ['only', 'extra'])
    assert.ok(ofType(events, 'plan.revised').length === 1)
    assert.equal(result.trace.length, 2)
  })
})

test('control: on the last step a replanner that adds nothing ends the run without a checkpoint past the plan', async () => {
  const control = createRunControl()
  const checkpoints: IRunSnapshot[] = []
  const script: Script = (req) => {
    switch (stageOf(req)) {
      case 'planner':
        return { text: planJson('only') }
      case 'executor':
        return { text: 'did it' }
      case 'replanner':
        return { text: decision('continue') }
      default:
        return { text: 'done' }
    }
  }
  await withLlm(script, async ({ llm, open }) => {
    const agent = await open({
      persistence: { onStepComplete: (s: IRunSnapshot) => void checkpoints.push(s) },
    })
    const result = await agent.run({
      input: 'go',
      control,
      onEvent: (e) => {
        if (e.type === 'step.complete') control.send('nothing to add really')
      },
    })
    assert.equal(at(llm, 'replanner').length, 1)
    assert.equal(at(llm, 'executor').length, 1, 'no step was invented')
    assert.equal(result.trace.length, 1)
    assert.ok(
      checkpoints.every((c) => c.stepIndex < (c.plan?.steps.length ?? 0)),
      'a checkpoint pointing past the last step would resume into nothing',
    )
  })
})

test('control: messages are weighed once; a later step boundary does not re-ask', async () => {
  const control = createRunControl()
  const script: Script = (req) => {
    switch (stageOf(req)) {
      case 'planner':
        return { text: planJson('a', 'b', 'c') }
      case 'executor':
        return { text: `did ${stepOf(req)}` }
      case 'replanner':
        return { text: decision('continue') }
      default:
        return { text: 'done' }
    }
  }
  await withLlm(script, async ({ llm, open }) => {
    const agent = await open()
    await agent.run({
      input: 'go',
      control,
      onEvent: (e) => {
        if (e.type === 'step.complete' && e.step.id === 'a') control.send('careful')
      },
    })
    assert.equal(at(llm, 'replanner').length, 1, 'one look for one message, not one per step')
    // ...but every later step still sees it, and so does the answer.
    assert.ok(userOf(at(llm, 'executor')[2]).includes('careful'))
    assert.ok(userOf(at(llm, 'synthesizer')[0]).includes('careful'))
  })
})

test('control: a message that says stop lets the replanner finish the run early', async () => {
  const control = createRunControl()
  const script: Script = (req) => {
    switch (stageOf(req)) {
      case 'planner':
        return { text: planJson('a', 'b', 'c') }
      case 'executor':
        return { text: `did ${stepOf(req)}` }
      case 'replanner':
        return { text: decision('finish') }
      default:
        return { text: 'Stopped early, as asked.' }
    }
  }
  await withLlm(script, async ({ llm, open }) => {
    const agent = await open()
    const result = await agent.run({
      input: 'go',
      control,
      onEvent: (e) => {
        if (e.type === 'step.complete' && e.step.id === 'a') control.send('stop, that is enough')
      },
    })
    assert.deepEqual(at(llm, 'executor').map(stepOf), ['a'])
    assert.equal(result.text, 'Stopped early, as asked.')
  })
})

// ── delivery at the end ──────────────────────────────────────────────────────

test('control: a message that arrives after the last step boundary is shown to the synthesizer', async () => {
  const control = createRunControl()
  const script: Script = (req) => {
    switch (stageOf(req)) {
      case 'planner':
        return { text: planJson('only') }
      case 'executor':
        return { text: 'did it' }
      case 'replanner':
        return { text: decision('continue') }
      default:
        return { text: 'answer' }
    }
  }
  await withLlm(script, async ({ llm, open }) => {
    const agent = await open()
    const { events, onEvent } = collect()
    const result = await agent.run({
      input: 'go',
      control,
      onEvent: (e) => {
        onEvent(e)
        // One while the step ends (weighed by the replanner), one while the replanner
        // thinks - too late for the boundary, in time for the answer.
        if (e.type === 'step.complete') control.send('first')
        if (e.type === 'replan.decision') control.send('second')
      },
    })
    const replanner = at(llm, 'replanner')[0]
    assert.ok(userOf(replanner).includes('first'))
    assert.ok(!userOf(replanner).includes('second'), 'the replanner had already started')
    const synth = at(llm, 'synthesizer')[0]
    assert.match(userOf(synth), /1\. first\n2\. second/, 'both, in order, in the answer prompt')
    assert.ok(!userOf(synth).includes('[NEW'), 'the answer prompt does not talk about a plan')
    assert.deepEqual(
      ofType(events, 'message.delivered').map((e) => e.at),
      ['step', 'final'],
    )
    assert.deepEqual(result.undelivered, [])
  })
})

test('control: a message sent while the answer streams comes back as undelivered, never shown', async () => {
  const control = createRunControl()
  const script: Script = (req) =>
    stageOf(req) === 'planner'
      ? { text: planJson('only') }
      : stageOf(req) === 'executor'
        ? { text: 'did it' }
        : { text: 'answer' }
  await withLlm(script, async ({ llm, open }) => {
    const agent = await open()
    const { events, onEvent } = collect()
    let said = false
    const result = await agent.run({
      input: 'go',
      control,
      onEvent: (e) => {
        onEvent(e)
        // The answer streams in several deltas; the user speaks once.
        if (e.type === 'final.text-delta' && !said) {
          said = true
          control.send('also, one more thing')
        }
      },
    })
    assert.deepEqual(result.undelivered, ['also, one more thing'])
    assert.ok(!llm.requests.some((r) => wire(r).includes('one more thing')), 'no request had it')
    assert.equal(ofType(events, 'message.delivered').length, 0)
    assert.equal(ofType(events, 'message.queued').length, 1, 'it was announced as queued')
    assert.equal(control.send('too late'), false, 'the run is over: nothing to deliver to')
    assert.deepEqual(control.pending(), ['also, one more thing'], 'still readable afterwards')
  })
})

test('control: an aborted run throws, and control.pending() still has what was never shown', async () => {
  const control = createRunControl()
  const ac = new AbortController()
  const script: Script = (req) =>
    stageOf(req) === 'planner' ? { text: planJson('a', 'b') } : { text: 'ok' }
  await withLlm(script, async ({ open }) => {
    const agent = await open()
    await assert.rejects(
      () =>
        agent.run({
          input: 'go',
          control,
          signal: ac.signal,
          onEvent: (e) => {
            if (e.type === 'plan.created') {
              control.send('sent just before the stop')
              ac.abort()
            }
          },
        }),
      (err: unknown) => (err as Error).name === 'AbortError',
    )
    assert.deepEqual(control.pending(), ['sent just before the stop'])
    assert.equal(control.send('after the throw'), false)
  })
})

test('control: a control that served a run starts the next one clean', async () => {
  const control = createRunControl()
  const script: Script = (req) =>
    stageOf(req) === 'planner' ? { text: planJson('a') } : { text: 'ok' }
  await withLlm(script, async ({ open }) => {
    const agent = await open()
    let said = false
    const first = await agent.run({
      input: 'one',
      control,
      onEvent: (e) => {
        if (e.type === 'final.text-delta' && !said) {
          said = true
          control.send('left over')
        }
      },
    })
    assert.deepEqual(first.undelivered, ['left over'])
    const { events, onEvent } = collect()
    const second = await agent.run({ input: 'two', control, onEvent })
    assert.deepEqual(second.undelivered, [], 'handed back once, not carried over')
    assert.equal(ofType(events, 'message.queued').length, 0)
  })
})

test('control: what was said before the run started is announced when it starts, in order', async () => {
  const control = createRunControl()
  control.send('before one')
  control.send('before two')
  const script: Script = (req) =>
    stageOf(req) === 'planner'
      ? { text: planJson('a', 'b') }
      : stageOf(req) === 'replanner'
        ? { text: decision('continue') }
        : { text: `ok ${stepOf(req)}` }
  await withLlm(script, async ({ llm, open }) => {
    const agent = await open()
    const { events, onEvent } = collect()
    await agent.run({ input: 'go', control, onEvent })
    assert.deepEqual(
      ofType(events, 'message.queued').map((e) => e.text),
      ['before one', 'before two'],
    )
    const first = at(llm, 'executor')[0]
    assert.equal(injected(first), 0, 'not into the first call of a step: the boundary handles it')
    // Delivered at the first boundary, together: one replanner look for both.
    assert.equal(at(llm, 'replanner').length, 1)
    assert.match(
      userOf(at(llm, 'replanner')[0]),
      /1\. before one[^\n]*\[NEW[^\n]*\n2\. before two[^\n]*\[NEW/,
    )
  })
})

test('control: with no iteration left to plan, the message still reaches the answer - and no replanner runs', async () => {
  const control = createRunControl()
  const script: Script = (req) =>
    stageOf(req) === 'planner'
      ? { text: planJson('a', 'b') }
      : stageOf(req) === 'replanner'
        ? { text: decision('revise', 'c') }
        : { text: 'ok' }
  await withLlm(script, async ({ llm, open }) => {
    const agent = await open({ maxIterations: 1 })
    const { events, onEvent } = collect()
    const result = await agent.run({
      input: 'go',
      control,
      onEvent: (e) => {
        onEvent(e)
        if (e.type === 'step.complete') control.send('and mind the budget')
      },
    })
    assert.equal(at(llm, 'replanner').length, 0, 'a revised plan could not run anyway')
    assert.match(userOf(at(llm, 'synthesizer')[0]), /and mind the budget/)
    assert.equal(ofType(events, 'message.delivered').length, 1)
    assert.deepEqual(result.undelivered, [])
  })
})

test('control: a run without a control sends exactly the prompts it always did', async () => {
  const script: Script = (req) =>
    stageOf(req) === 'planner'
      ? { text: planJson('a', 'b') }
      : stageOf(req) === 'replanner'
        ? { text: decision('continue') }
        : { text: 'ok' }
  await withLlm(script, async ({ llm, open }) => {
    // 'always' puts the replanner prompt in play too.
    const agent = await open({ replanAfter: 'always' })
    const { events, onEvent } = collect()
    const result = await agent.run({ input: 'go', onEvent })
    assert.equal(result.undelivered, undefined)
    assert.ok(!events.some((e) => e.type.startsWith('message.')))
    assert.deepEqual(llm.requests.map(stageOf), [
      'planner',
      'executor',
      'replanner',
      'executor',
      'synthesizer',
    ])
    for (const req of llm.requests) {
      assert.doesNotMatch(wire(req), /Messages? from the user|NEW MESSAGE|\[NEW/i, stageOf(req))
    }
  })
})

// ── persistence ──────────────────────────────────────────────────────────────

test('control: what the user said survives a crash - and the resumed run still knows it', async () => {
  const control = createRunControl()
  const saved = new Map<string, IRunSnapshot>()
  const ac = new AbortController()
  const persistence = {
    onRunStart: (s: IRunSnapshot) => void saved.set(s.runId, s),
    onStepComplete: (s: IRunSnapshot) => {
      saved.set(s.runId, s)
      if (s.trace.length === 1) ac.abort()
    },
    loadRun: (id: string) => saved.get(id) ?? null,
  }
  const script: Script = (req) => {
    switch (stageOf(req)) {
      case 'planner':
        return { text: planJson('a', 'b') }
      case 'executor':
        return { text: `did ${stepOf(req)}` }
      case 'replanner':
        return { text: decision('continue') }
      default:
        return { text: 'done' }
    }
  }
  await withLlm(script, async ({ llm, open }) => {
    const first = await open({ persistence })
    let runId = ''
    await assert.rejects(() =>
      first.run({
        input: 'go',
        control,
        signal: ac.signal,
        onEvent: (e) => {
          if (e.runId) runId = e.runId
          if (e.type === 'step.complete') control.send('keep it short')
        },
      }),
    )
    assert.deepEqual(saved.get(runId)?.userUpdates, [{ text: 'keep it short', reconciled: true }])

    const second = await open({ persistence })
    await second.run({ input: '', resumeFromRunId: runId })
    assert.match(userOf(at(llm, 'executor').at(-1) as IChatRequest), /keep it short/)
    assert.match(userOf(at(llm, 'synthesizer')[0]), /keep it short/)
  })
})

// ── subagents ────────────────────────────────────────────────────────────────

/** A child tool that never returns on its own: it waits for the abort. */
const hangTool = () =>
  tool({
    description: 'Wait',
    inputSchema: z.object({}),
    execute: (_input, { abortSignal }) =>
      new Promise<string>((resolve) => {
        if (abortSignal?.aborted) return resolve('aborted')
        abortSignal?.addEventListener('abort', () => resolve('aborted'), { once: true })
      }),
  })

// A parent delegating to two children in one round: "slow" never finishes, "quick" does.
const delegatingScript: Script = (req) => {
  const stage = stageOf(req)
  const child = systemOf(req).includes('CHILD AGENT')
  if (stage === 'planner') return { text: planJson('s1') }
  if (stage === 'replanner') return { text: decision('continue') }
  if (stage === 'synthesizer') {
    if (!child) return { text: 'Parent answer.' }
    return { text: userOf(req).includes('slow') ? 'never' : 'QUICK-ANSWER' }
  }
  if (child) {
    if (userOf(req).includes('slow')) {
      return hasToolResult(req) ? { text: 'gave up' } : { toolCalls: [{ name: 'hang', args: {} }] }
    }
    return { text: 'quick result' }
  }
  return hasToolResult(req)
    ? { text: 'delegated' }
    : {
        toolCalls: [
          { name: 'slow_agent', args: { task: 'slow' } },
          { name: 'quick_agent', args: { task: 'quick' } },
        ],
      }
}

for (const isolation of ['in-process', 'worker'] as const) {
  test(`control (${isolation}): the host sees which subagents run, stops ONE, and the parent carries on`, async () => {
    const control = createRunControl()
    await withLlm(delegatingScript, async ({ llm, open }) => {
      const child = config(llm.baseURL, { systemPrompt: 'CHILD AGENT' })
      const agent = await open({
        tools: {
          slow_agent: createSubagentTool({
            name: 'slow_agent',
            description: 'Takes long',
            config: child,
            isolation,
            tools: { hang: hangTool() },
          }),
          quick_agent: createSubagentTool({
            name: 'quick_agent',
            description: 'Takes no time',
            config: child,
            isolation,
          }),
        },
      })
      const { events, onEvent } = collect()
      let listed: ReturnType<RunControl['subagents']> = []
      let stopped: boolean | undefined
      let afterStep: ReturnType<RunControl['subagents']> | undefined
      const result = await agent.run({
        input: 'delegate two things',
        control,
        onEvent: (e) => {
          onEvent(e)
          // Both children are done by the time the step is: neither is still listed.
          if (e.type === 'step.complete') afterStep = control.subagents()
          // The slow child is mid-task once it has called its tool.
          if (
            e.type === 'subagent.event' &&
            e.name === 'slow_agent' &&
            e.event.type === 'step.tool-call'
          ) {
            listed = control.subagents()
            const slow = listed.find((s) => s.name === 'slow_agent')
            stopped = slow ? control.stopSubagent(slow.id) : undefined
          }
        },
      })

      const slowInfo = listed.find((s) => s.name === 'slow_agent')
      assert.ok(slowInfo, 'the running child is listed')
      assert.equal(slowInfo.task, 'slow')
      assert.ok(slowInfo.id && slowInfo.startedAt > 0)
      assert.equal(stopped, true)

      // Only that child failed - with a reason, flagged as the user's doing.
      const errors = ofType(events, 'subagent.error')
      assert.equal(errors.length, 1)
      assert.equal(errors[0].name, 'slow_agent')
      assert.equal(errors[0].id, slowInfo.id)
      assert.equal(errors[0].stopped, true)
      assert.match(errors[0].error, /stopped by the user/)
      assert.ok(ofType(events, 'subagent.complete').some((e) => e.name === 'quick_agent'))

      // The run carried on: the parent got the failure as a tool error it can route around.
      const calls = result.trace[0].toolCalls
      const bySlow = calls.find((c) => c.name === 'slow_agent')
      const byQuick = calls.find((c) => c.name === 'quick_agent')
      assert.equal(bySlow?.ok, false)
      assert.match(String((bySlow?.output as Error).message), /stopped by the user/)
      assert.equal(byQuick?.ok, true)
      assert.equal(byQuick?.output, 'QUICK-ANSWER')
      assert.equal(result.text, 'Parent answer.')
      assert.deepEqual(afterStep, [], 'a finished or stopped subagent leaves the list')
      assert.deepEqual(control.subagents(), [])
      assert.equal(
        control.stopSubagent(slowInfo.id),
        false,
        'a finished subagent cannot be stopped',
      )
    })
  })
}

test('control: a subagent that fails on its own is not marked as stopped by the user', async () => {
  const control = createRunControl()
  const script: Script = (req) => {
    const stage = stageOf(req)
    if (stage === 'planner') return { text: planJson('s1') }
    if (stage === 'replanner') return { text: decision('continue') }
    if (stage === 'synthesizer') return { text: 'Parent answer.' }
    return hasToolResult(req)
      ? { text: 'delegated' }
      : { toolCalls: [{ name: 'w', args: { task: 'x' } }] }
  }
  await withLlm(script, async ({ open }) => {
    const agent = await open({
      tools: {
        w: createSubagentTool({
          name: 'w',
          description: 'Breaks',
          // Nothing listens there: the child's first model call is refused.
          config: config('http://127.0.0.1:1/v1', { systemPrompt: 'CHILD AGENT' }),
          isolation: 'in-process',
        }),
      },
    })
    const { events, onEvent } = collect()
    await agent.run({ input: 'delegate', control, onEvent })
    const err = ofType(events, 'subagent.error')[0]
    assert.ok(err, 'the failure was reported')
    assert.equal(err.stopped, undefined)
    assert.doesNotMatch(err.error, /stopped by the user/)
  })
})
