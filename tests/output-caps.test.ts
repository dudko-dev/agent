import assert from 'node:assert/strict'
import test from 'node:test'
import { NoObjectGeneratedError } from 'ai'
import {
  OUTPUT_CAP_SHARES,
  outputCapNotice,
  stageCallOptions,
  stageOutputCap,
  withCapHint,
} from '../src/call-options.ts'
import { createAgent } from '../src/index.ts'
import type { AgentEvent, AgentStage, IAgent, IAgentConfig } from '../src/types.ts'
import {
  startLocalOpenAI,
  systemOf,
  type IChatRequest,
  type ILocalOpenAI,
  type IScriptedReply,
  type Script,
} from './helpers/openai-server.ts'

// The output cap of one LLM call: what the host set wins, `0` turns it off, and otherwise it is a
// share of the context window between a floor and a ceiling - never a fixed number, which is wrong
// at one end of the range of windows or the other.

const config = (extra: Partial<IAgentConfig> = {}): IAgentConfig => ({
  clientName: 'caps-test',
  providerType: 'openai',
  apiKey: 'k',
  model: 'm',
  mcpServers: {},
  maxIterations: 1,
  maxStepsPerTask: 1,
  logLevel: 'none',
  ...extra,
})

const STAGES: AgentStage[] = ['planner', 'executor', 'replanner', 'synthesizer']
const capsOf = (c: IAgentConfig) => STAGES.map((s) => stageOutputCap(c, s).tokens)
const window = (tokens: number): Partial<IAgentConfig> => ({
  compaction: { contextWindowTokens: tokens },
})

// ── the numbers ────────────────────────────────────────────────────────────

test('default caps at the default 128k window: planner 2000, executor 8000, replanner 1000, synthesizer 4000', () => {
  assert.deepEqual(capsOf(config()), [2000, 8000, 1000, 4000])
  for (const stage of STAGES) assert.equal(stageOutputCap(config(), stage).derived, true)
})

test('the caps follow the window: ceilings on a huge one, floors on a small one', () => {
  // 1M window: every share is past its ceiling.
  assert.deepEqual(capsOf(config(window(1_000_000))), [4000, 32_000, 2000, 16_000])
  // 200k (Claude): between the floors and the ceilings.
  assert.deepEqual(capsOf(config(window(200_000))), [3125, 12_500, 1562, 6250])
  // 32k: the shares fall below the floors.
  assert.deepEqual(capsOf(config(window(32_000))), [512, 2048, 256, 1024])
})

test('a cap never takes more than half of a small window, whatever the floor says', () => {
  // 4096: the executor floor (2048) is exactly half; the planner's floor (512) is well inside.
  assert.deepEqual(capsOf(config(window(4096))), [512, 2048, 256, 1024])
  // 2048: the floors would be 512/2048/256/1024 - the executor and synthesizer are held to 1024.
  assert.deepEqual(capsOf(config(window(2048))), [512, 1024, 256, 1024])
})

test('the shares and bounds are the documented ones', () => {
  assert.deepEqual(OUTPUT_CAP_SHARES.executor, { num: 1, den: 16, min: 2048, max: 32_000 })
  assert.deepEqual(OUTPUT_CAP_SHARES.planner, { num: 1, den: 64, min: 512, max: 4000 })
  assert.deepEqual(OUTPUT_CAP_SHARES.replanner, { num: 1, den: 128, min: 256, max: 2000 })
  assert.deepEqual(OUTPUT_CAP_SHARES.synthesizer, { num: 1, den: 32, min: 1024, max: 16_000 })
})

// ── the host's word wins ───────────────────────────────────────────────────

test('limits.perCall wins - also above the share, and above half the window', () => {
  const c = config({
    ...window(4096),
    limits: { perCall: { planner: 100, executor: 50_000, synthesizer: 77 } },
  })
  assert.deepEqual(stageOutputCap(c, 'planner'), { tokens: 100, derived: false })
  assert.deepEqual(stageOutputCap(c, 'executor'), { tokens: 50_000, derived: false })
  assert.deepEqual(stageOutputCap(c, 'synthesizer'), { tokens: 77, derived: false })
  // The stage it did not mention still gets its share.
  assert.deepEqual(stageOutputCap(c, 'replanner'), { tokens: 256, derived: true })
})

test('limits.perCall of 0 (or less) is an explicit "no cap", not "use the default"', () => {
  for (const off of [0, -5]) {
    const c = config({ limits: { perCall: { executor: off } } })
    assert.deepEqual(stageOutputCap(c, 'executor'), { derived: false })
    assert.equal(stageCallOptions(c, 'executor', 'S').maxOutputTokens, undefined)
  }
})

test('a non-numeric perCall is treated as unset', () => {
  const c = config({ limits: { perCall: { executor: Number.NaN } } })
  assert.deepEqual(stageOutputCap(c, 'executor'), { tokens: 8000, derived: true })
})

// ── a stage that thinks ────────────────────────────────────────────────────

test('a stage that thinks gets no derived cap: the reasoning counts against it on OpenAI and Gemini', () => {
  const thinking = config({ thinking: 'low' })
  for (const stage of STAGES) {
    assert.deepEqual(stageOutputCap(thinking, stage), { derived: false }, stage)
  }
  // An exact budget is thinking too.
  assert.deepEqual(
    stageOutputCap(config({ thinking: { level: 'high', budgetTokens: 4000 } }), 'executor'),
    {
      derived: false,
    },
  )
  // ...but the host can still cap it.
  const capped = config({ thinking: 'low', limits: { perCall: { executor: 12_000 } } })
  assert.deepEqual(stageOutputCap(capped, 'executor'), { tokens: 12_000, derived: false })
})

test('thinking is per stage: stageThinking false (or level none) keeps that stage on its share', () => {
  const c = config({
    thinking: 'medium',
    stageThinking: { planner: false, replanner: 'none' },
  })
  assert.deepEqual(stageOutputCap(c, 'planner'), { tokens: 2000, derived: true })
  assert.deepEqual(stageOutputCap(c, 'replanner'), { tokens: 1000, derived: true })
  assert.deepEqual(stageOutputCap(c, 'executor'), { derived: false })
  assert.deepEqual(stageOutputCap(c, 'synthesizer'), { derived: false })
})

test('stageCallOptions sends the derived cap as maxOutputTokens', () => {
  assert.equal(stageCallOptions(config(), 'synthesizer', 'S').maxOutputTokens, 4000)
  assert.equal(
    stageCallOptions(config({ thinking: true }), 'synthesizer', 'S').maxOutputTokens,
    undefined,
  )
})

// ── saying so when the cap cut a call off ──────────────────────────────────

test('outputCapNotice speaks only for a call cut off at a cap in force', () => {
  assert.equal(outputCapNotice(config(), 'synthesizer', 'stop'), undefined)
  assert.equal(outputCapNotice(config(), 'synthesizer', undefined), undefined)
  // No cap in force (the stage thinks, or the host turned it off): nothing to blame.
  assert.equal(outputCapNotice(config({ thinking: 'low' }), 'synthesizer', 'length'), undefined)
  assert.equal(
    outputCapNotice(config({ limits: { perCall: { synthesizer: 0 } } }), 'synthesizer', 'length'),
    undefined,
  )

  const derived = outputCapNotice(config(), 'synthesizer', 'length') ?? ''
  assert.match(derived, /^\[synthesizer\] .*cut off at 4000 tokens, the default cap/)
  assert.match(derived, /128000-token window/)
  assert.match(derived, /raise limits\.perCall\.synthesizer, or set it to 0/)

  const set =
    outputCapNotice(config({ limits: { perCall: { executor: 900 } } }), 'executor', 'length') ?? ''
  assert.match(set, /cut off at limits\.perCall\.executor \(900 tokens\); raise it/)
  assert.doesNotMatch(set, /default/)
})

const noObject = (finishReason: 'length' | 'stop') =>
  new NoObjectGeneratedError({
    message: 'No object generated: could not parse the response.',
    response: { id: 'r', timestamp: new Date(0), modelId: 'm' },
    usage: {} as never,
    finishReason,
  })

test('withCapHint explains a plan cut by the cap, on the same error object', () => {
  const err = noObject('length')
  const out = withCapHint(err, config(), 'planner')
  assert.equal(out, err, 'the same error, so the retry logic sees the same class')
  assert.match(err.message, /could not parse the response\. - \[planner\] .*cut off at 2000 tokens/)
})

test('withCapHint leaves other failures alone', () => {
  const stopped = noObject('stop')
  withCapHint(stopped, config(), 'planner')
  assert.equal(stopped.message, 'No object generated: could not parse the response.')

  const plain = new Error('boom')
  assert.equal(withCapHint(plain, config(), 'planner'), plain)
  assert.equal(plain.message, 'boom')

  // Cut off, but nothing of ours was capping it: not our message to add.
  const free = noObject('length')
  withCapHint(free, config({ limits: { perCall: { planner: 0 } } }), 'planner')
  assert.equal(free.message, 'No object generated: could not parse the response.')
})

// ── on the wire ────────────────────────────────────────────────────────────

type Stage = 'planner' | 'executor' | 'replanner' | 'synthesizer' | 'other'
const stageOf = (req: IChatRequest): Stage => {
  const system = systemOf(req)
  if (system.includes('You are the Planner')) return 'planner'
  if (system.includes('You are the Replanner')) return 'replanner'
  if (system.includes('You are the Synthesizer')) return 'synthesizer'
  if (system.includes('You are the Executor')) return 'executor'
  return 'other'
}

const plan = JSON.stringify({
  thought: 'Two steps.',
  steps: ['s1', 's2'].map((id) => ({
    id,
    description: `Step ${id}`,
    expectedOutcome: `${id} done`,
    suggestedTools: [],
  })),
})

const happy: Script = (req) => {
  switch (stageOf(req)) {
    case 'planner':
      return { text: plan }
    case 'replanner':
      return { text: JSON.stringify({ mode: 'continue', reason: 'on track' }) }
    case 'executor':
      return { text: 'did it' }
    default:
      return { text: 'All done.' }
  }
}

const wireConfig = (baseURL: string, extra: Partial<IAgentConfig> = {}): IAgentConfig => ({
  clientName: 'caps-wire',
  providerType: 'openai-compatible',
  baseURL,
  apiKey: 'not-a-real-key',
  model: 'scripted',
  mcpServers: {},
  maxIterations: 6,
  maxStepsPerTask: 3,
  replanAfter: 'always',
  logLevel: 'none',
  ...extra,
})

const withRun = async (
  script: Script,
  extra: Partial<IAgentConfig>,
  body: (r: {
    llm: ILocalOpenAI
    events: AgentEvent[]
    run: () => Promise<unknown>
  }) => Promise<void>,
): Promise<void> => {
  const llm = await startLocalOpenAI(script)
  let agent: IAgent | undefined
  try {
    agent = await createAgent(wireConfig(llm.baseURL, extra))
    const events: AgentEvent[] = []
    await body({
      llm,
      events,
      run: () => agent!.run({ input: 'Do two things', onEvent: (e) => events.push(e) }),
    })
  } finally {
    await agent?.close().catch(() => {})
    await llm.close()
  }
}

const capOnWire = (llm: ILocalOpenAI, stage: Stage): (number | undefined)[] =>
  llm.requests
    .filter((r) => stageOf(r) === stage)
    .map((r) => r.max_tokens ?? r.max_completion_tokens)

test('wire: with no limits set every stage sends its window-derived cap', async () => {
  await withRun(happy, {}, async ({ llm, run }) => {
    await run()
    assert.deepEqual(capOnWire(llm, 'planner'), [2000])
    assert.deepEqual(capOnWire(llm, 'executor'), [8000, 8000])
    assert.deepEqual(capOnWire(llm, 'replanner'), [1000])
    assert.deepEqual(capOnWire(llm, 'synthesizer'), [4000])
  })
})

test('wire: a bigger window raises the caps, up to the ceilings', async () => {
  await withRun(happy, window(1_000_000), async ({ llm, run }) => {
    await run()
    assert.deepEqual(capOnWire(llm, 'planner'), [4000])
    assert.deepEqual(capOnWire(llm, 'executor'), [32_000, 32_000])
    assert.deepEqual(capOnWire(llm, 'replanner'), [2000])
    assert.deepEqual(capOnWire(llm, 'synthesizer'), [16_000])
  })
})

test('wire: perCall wins per stage, and 0 sends no cap at all', async () => {
  const extra = { limits: { perCall: { synthesizer: 77, executor: 0 } } }
  await withRun(happy, extra, async ({ llm, run }) => {
    await run()
    assert.deepEqual(capOnWire(llm, 'synthesizer'), [77])
    assert.deepEqual(capOnWire(llm, 'executor'), [undefined, undefined], 'executor: no cap sent')
    assert.deepEqual(capOnWire(llm, 'planner'), [2000], 'the rest keep their share')
  })
})

test('wire: a stage that thinks sends no derived cap', async () => {
  await withRun(happy, { stageThinking: { executor: 'low' } }, async ({ llm, run }) => {
    await run()
    assert.deepEqual(capOnWire(llm, 'executor'), [undefined, undefined])
    assert.deepEqual(capOnWire(llm, 'synthesizer'), [4000])
  })
})

const logsOf = (events: AgentEvent[]) =>
  events.filter((e): e is Extract<AgentEvent, { type: 'log' }> => e.type === 'log')

test('a synthesis cut off by its cap says so, naming the cap and how to lift it', async () => {
  const script: Script = (req) =>
    stageOf(req) === 'synthesizer'
      ? ({ text: 'A long answer that', cutOff: true } as IScriptedReply)
      : happy(req)
  await withRun(script, {}, async ({ events, run }) => {
    await run()
    const warn = logsOf(events).filter(
      (l) => l.level === 'warn' && l.message.startsWith('[synthesizer]'),
    )
    assert.equal(warn.length, 1)
    assert.match(warn[0].message, /cut off at 4000 tokens, the default cap/)
  })
})

test('an executor step cut off by its cap says so', async () => {
  const script: Script = (req) =>
    stageOf(req) === 'executor'
      ? ({ text: 'half a sentence', cutOff: true } as IScriptedReply)
      : happy(req)
  await withRun(script, {}, async ({ events, run }) => {
    await run()
    const warn = logsOf(events).filter(
      (l) => l.message.startsWith('[executor]') && /cut off/.test(l.message),
    )
    assert.ok(warn.length >= 1)
    assert.match(warn[0].message, /cut off at 8000 tokens/)
  })
})

test('no notice when the call was not cut off', async () => {
  await withRun(happy, {}, async ({ events, run }) => {
    await run()
    assert.deepEqual(
      logsOf(events).filter((l) => /cut off/.test(l.message)),
      [],
    )
  })
})

test('a plan cut off by its cap is reported with a message that names the cap', async () => {
  const script: Script = (req) =>
    stageOf(req) === 'planner'
      ? ({
          text: '{"thought":"Two steps.","steps":[{"id":"s1","descr',
          cutOff: true,
        } as IScriptedReply)
      : happy(req)
  await withRun(script, {}, async ({ events, run }) => {
    await run() // the runner survives a bad plan and answers; the error is what a host sees
    const errors = events.filter(
      (e): e is Extract<AgentEvent, { type: 'error' }> => e.type === 'error',
    )
    assert.equal(errors.length, 1)
    assert.equal(errors[0].phase, 'plan')
    assert.match(errors[0].error.message, /\[planner\] .*cut off at 2000 tokens/)
  })
})

test('a replanner decision cut off by its cap fails the run with a message that names the cap', async () => {
  const script: Script = (req) =>
    stageOf(req) === 'replanner'
      ? ({ text: '{"mode":"continue","reas', cutOff: true } as IScriptedReply)
      : happy(req)
  await withRun(script, {}, async ({ run }) => {
    await assert.rejects(run(), /\[replanner\] .*cut off at 1000 tokens/)
  })
})
