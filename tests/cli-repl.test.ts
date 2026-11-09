import assert from 'node:assert/strict'
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import test from 'node:test'
import {
  startLocalOpenAI,
  systemOf,
  userOf,
  type IChatRequest,
  type ILocalOpenAI,
  type Script,
} from './helpers/openai-server.ts'

// The real REPL (src/cli/start.ts) as a subprocess against a scripted OpenAI-compatible
// endpoint, with lines written to its stdin at the moments a person would type them: while
// the agent works. The model's slow answers are what give the test time to act.

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
const planJson = (...ids: string[]) =>
  JSON.stringify({
    thought: 'Do it step by step.',
    steps: ids.map((id) => ({
      id,
      description: `Step ${id}`,
      expectedOutcome: `${id} done`,
      suggestedTools: [],
    })),
  })
const at = (llm: ILocalOpenAI, stage: Stage): IChatRequest[] =>
  llm.requests.filter((r) => stageOf(r) === stage)

interface IRepl {
  child: ChildProcessWithoutNullStreams
  out: () => string
  say: (line: string) => void
  until: (pattern: RegExp, ms?: number) => Promise<void>
  exited: Promise<number | null>
}

const startRepl = (llm: ILocalOpenAI): IRepl => {
  const child = spawn(process.execPath, ['--experimental-strip-types', 'src/cli/start.ts'], {
    cwd: process.cwd(),
    env: {
      PATH: process.env.PATH ?? '',
      AGENT_PROVIDER_TYPE: 'openai-compatible',
      AGENT_BASE_URL: llm.baseURL,
      AGENT_API_KEY: 'not-a-real-key',
      AGENT_MODEL: 'scripted',
      AGENT_LOG_LEVEL: 'none',
      AGENT_LLM_MAX_RETRIES: '0',
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  let buffer = ''
  child.stdout.on('data', (d: Buffer) => (buffer += d.toString()))
  child.stderr.on('data', (d: Buffer) => (buffer += d.toString()))
  const exited = new Promise<number | null>((resolve) => child.on('exit', (code) => resolve(code)))
  return {
    child,
    out: () => buffer,
    say: (line) => void child.stdin.write(`${line}\n`),
    until: async (pattern, ms = 20_000) => {
      const t0 = Date.now()
      while (!pattern.test(buffer)) {
        if (Date.now() - t0 > ms) {
          throw new Error(`timed out waiting for ${pattern}; output so far:\n${buffer}`)
        }
        await new Promise((r) => setTimeout(r, 25))
      }
    },
    exited,
  }
}

const finish = async (repl: IRepl): Promise<void> => {
  repl.say('/exit')
  await Promise.race([
    repl.exited,
    new Promise((_, reject) => setTimeout(() => reject(new Error('REPL did not exit')), 15_000)),
  ])
}

test('REPL: a line typed while the agent works is delivered at the step boundary, re-plans, and enters the history', async () => {
  const script: Script = (req) => {
    switch (stageOf(req)) {
      case 'planner':
        return { text: planJson('a', 'b') }
      case 'executor':
        // Step a is slow: there is time to type.
        return stepOf(req) === 'a' ? { text: 'did a', delayMs: 1500 } : { text: 'did b' }
      case 'replanner':
        return { text: JSON.stringify({ mode: 'continue', reason: 'still fits' }) }
      default:
        return { text: 'All done.' }
    }
  }
  const llm = await startLocalOpenAI(script)
  const repl = startRepl(llm)
  try {
    await repl.until(/you> /)
    repl.say('go')
    await repl.until(/\[step 1\]/)
    repl.say('use metric units')
    await repl.until(/\[meta\]/)

    const out = repl.out()
    assert.match(out, /\[you->agent\] queued/)
    assert.match(out, /\[you->agent\] delivered \(step\): use metric units/)
    assert.match(out, /\[replan\]\s+continue \(user-message\)/, 'a message re-checks the plan')
    assert.ok(out.indexOf('queued') < out.indexOf('delivered (step)'))

    // The model was told: the replanner and step b's executor have it, step a's did not.
    const executor = at(llm, 'executor')
    assert.ok(!userOf(executor[0]).includes('use metric units'))
    assert.match(userOf(executor[1]), /use metric units/)
    assert.match(userOf(at(llm, 'replanner')[0]), /use metric units\s+\[NEW/)
    assert.match(userOf(at(llm, 'synthesizer')[0]), /use metric units/)

    // And the next prompt remembers it, as a user turn between the goal and the answer.
    const before = repl.out().length
    repl.say('/history')
    await repl.until(/assistant: All done\./)
    const shown = repl.out().slice(before)
    // With piped stdin the first line shares a line with the "you> " prompt.
    const turns = [...shown.matchAll(/(?:^|\s)(user|assistant): (.+)$/gm)].map(
      (m) => `${m[1]}: ${m[2]}`,
    )
    assert.deepEqual(turns, ['user: go', 'user: use metric units', 'assistant: All done.'])

    // A second run listens again - once, not twice (a leftover listener would send it twice).
    repl.say('again')
    await repl.until(/\[step 1\][\s\S]*\[step 1\]/)
    repl.say('second note')
    for (let i = 0; i < 800 && (repl.out().match(/\[meta\]/g) ?? []).length < 2; i += 1) {
      await new Promise((r) => setTimeout(r, 25))
    }
    const queued = repl.out().match(/\[you->agent\] queued[^\n]*second note/g) ?? []
    assert.equal(queued.length, 1, 'said once, queued once')
    assert.equal(at(llm, 'replanner').length, 2, 'one forced look per run that was spoken to')
  } finally {
    await finish(repl).catch(() => repl.child.kill())
    await llm.close()
  }
})

test('REPL: a line typed while the answer is written is sent as the next prompt', async () => {
  const script: Script = (req) => {
    switch (stageOf(req)) {
      case 'planner':
        return { text: planJson('a') }
      case 'executor':
        return { text: 'did a' }
      default:
        // The first answer is slow; the follow-up's is not.
        return userOf(req).includes('one more thing')
          ? { text: 'Second answer.' }
          : { text: 'First answer.', delayMs: 1500 }
    }
  }
  const llm = await startLocalOpenAI(script)
  const repl = startRepl(llm)
  try {
    await repl.until(/you> /)
    repl.say('hello')
    // The synthesizer's request is in: the answer is being written.
    for (let i = 0; i < 400 && at(llm, 'synthesizer').length === 0; i += 1) {
      await new Promise((r) => setTimeout(r, 25))
    }
    assert.equal(at(llm, 'synthesizer').length, 1)
    repl.say('and one more thing')
    await repl.until(/Second answer\./)

    const out = repl.out()
    assert.match(
      out,
      /\[follow-up\] sending what the last run never showed the agent: and one more thing/,
    )
    assert.match(out, /First answer\./)
    // Two runs: the second one's planner got the late message as its goal.
    assert.equal(at(llm, 'planner').length, 2)
    assert.match(userOf(at(llm, 'planner')[1]), /and one more thing/)
    assert.ok(!at(llm, 'executor').some((r) => userOf(r).includes('NEW MESSAGE')))
  } finally {
    await finish(repl).catch(() => repl.child.kill())
    await llm.close()
  }
})

test('REPL: during a run a command is a hint, /agents says nothing runs, and Ctrl-C-free exit still works', async () => {
  const script: Script = (req) =>
    stageOf(req) === 'planner'
      ? { text: planJson('a') }
      : stageOf(req) === 'executor'
        ? { text: 'did a', delayMs: 1200 }
        : { text: 'Done.' }
  const llm = await startLocalOpenAI(script)
  const repl = startRepl(llm)
  try {
    await repl.until(/you> /)
    repl.say('/agents') // between runs
    await repl.until(/\(none running - subagents show here while a run goes\)/)
    repl.say('go')
    await repl.until(/\[step 1\]/)
    repl.say('/compact') // a REPL command is not a message to the agent
    repl.say('/agents')
    repl.say('/stop')
    await repl.until(/\[meta\]/)
    const out = repl.out()
    assert.match(out, /\[hint\]\s+commands work between runs/)
    assert.match(out, /\[agents\]\s+\(none running\)/)
    assert.match(out, /\[stop\]\s+no subagent is running/)
    assert.ok(!out.includes('[you->agent]'), 'none of those was sent to the agent')
    assert.equal(at(llm, 'replanner').length, 0, 'nothing was said, so nothing forced a replan')
  } finally {
    await finish(repl).catch(() => repl.child.kill())
    await llm.close()
  }
})

test('REPL: /usage is what the session has spent so far; each answer shows the running total; /status shows where compaction starts', async () => {
  // Every call reports 100 in / 20 out: a run of planner + step + answer is 360 tokens.
  const script: Script = (req) =>
    stageOf(req) === 'planner'
      ? { text: planJson('a'), usage: { prompt: 100, completion: 20 } }
      : {
          text: stageOf(req) === 'executor' ? 'did a' : 'Done.',
          usage: { prompt: 100, completion: 20 },
        }
  const llm = await startLocalOpenAI(script)
  const repl = startRepl(llm)
  try {
    await repl.until(/you> /)
    repl.say('/usage') // nothing spent yet
    await repl.until(/\[usage\]\s+0 tokens \(in=0 out=0\) this session/)
    repl.say('first')
    await repl.until(/tokens=360 \(in=300 out=60\) session=360/)
    repl.say('second')
    await repl.until(/tokens=360 \(in=300 out=60\) session=720/)
    repl.say('/usage')
    await repl.until(/\[usage\]\s+720 tokens \(in=600 out=120\) this session/)
    repl.say('/status')
    await repl.until(/compaction=auto window=128000 at=108800/)
  } finally {
    await finish(repl).catch(() => repl.child.kill())
    await llm.close()
  }
})
