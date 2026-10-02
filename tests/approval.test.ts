import assert from 'node:assert/strict'
import test from 'node:test'
import {
  createApprovalController,
  decideToolPermission,
  isReadOnlyTool,
  markReadOnly,
  matchToolRule,
  ToolDeniedError,
} from '../src/approval.ts'
import { runContext } from '../src/context.ts'
import type { AgentEvent, IToolApprovalRequest } from '../src/types.ts'

test('matchToolRule: exact beats any glob; the longest glob wins among globs', () => {
  const rules = {
    '*': 'ask',
    'github__*': 'allow',
    'github__delete_*': 'deny',
    github__delete_repo: 'ask',
  } as const
  assert.deepEqual(matchToolRule(rules, 'github__delete_repo'), {
    pattern: 'github__delete_repo',
    permission: 'ask',
  })
  assert.equal(matchToolRule(rules, 'github__delete_issue')?.permission, 'deny')
  assert.equal(matchToolRule(rules, 'github__list')?.permission, 'allow')
  assert.equal(matchToolRule(rules, 'jira__x')?.pattern, '*')
  assert.equal(matchToolRule({ 'a.b*': 'deny' }, 'aXb'), undefined, 'regex chars are literal')
  assert.equal(matchToolRule(undefined, 'x'), undefined)
})

test('decideToolPermission: mode defaults', () => {
  const d = (mode: 'autopilot' | 'ask-writes' | 'ask-all' | 'read-only', readOnly: boolean) =>
    decideToolPermission({ name: 't', readOnly, mode }).permission
  assert.equal(d('autopilot', false), 'allow')
  assert.equal(d('read-only', true), 'allow')
  assert.equal(d('read-only', false), 'deny')
  assert.equal(d('ask-writes', true), 'allow')
  assert.equal(d('ask-writes', false), 'ask')
  assert.equal(d('ask-all', true), 'ask')
})

test('decideToolPermission order: built-in > remembered > rule > mode', () => {
  const base = { name: 'fs__rm', readOnly: false, mode: 'ask-all' as const }
  assert.deepEqual(decideToolPermission({ ...base, builtIn: true, rules: { '*': 'deny' } }), {
    permission: 'allow',
    source: 'builtin',
  })
  assert.equal(
    decideToolPermission({ ...base, remembered: new Set(['fs__rm']), rules: { 'fs__*': 'deny' } })
      .source,
    'remembered',
  )
  assert.deepEqual(decideToolPermission({ ...base, rules: { 'fs__*': 'deny' } }), {
    permission: 'deny',
    source: 'rule',
    rule: 'fs__*',
  })
  // A rule beats the mode in both directions.
  assert.equal(
    decideToolPermission({ ...base, mode: 'read-only', rules: { fs__rm: 'allow' } }).permission,
    'allow',
  )
  assert.equal(
    decideToolPermission({ ...base, mode: 'autopilot', rules: { fs__rm: 'ask' } }).permission,
    'ask',
  )
})

test('markReadOnly / isReadOnlyTool', () => {
  const t = markReadOnly({ description: 'x' })
  assert.equal(isReadOnlyTool(t), true)
  assert.equal(isReadOnlyTool({}), false)
  assert.equal(isReadOnlyTool(markReadOnly({}, false)), false)
})

test('ToolDeniedError carries the reason and serialises to its message', () => {
  const e = new ToolDeniedError('not today')
  assert.equal(e.name, 'ToolDeniedError')
  assert.equal(
    e.message,
    'Tool call denied by the user: not today. Do not retry it; continue without it, or report what is blocked.',
  )
  assert.equal(JSON.parse(JSON.stringify({ e })).e, e.message)
  assert.match(new ToolDeniedError().message, /^Tool call denied by the user\. Do not retry/)
})

const inRun = <T>(events: AgentEvent[], fn: () => Promise<T>): Promise<T> =>
  runContext.run(
    {
      runId: 'run-1',
      startedAt: 0,
      sandboxDir: '/tmp/x',
      emit: (e) => events.push(e),
      currentStep: { id: 's1', description: 'd', expectedOutcome: 'e' },
    },
    fn,
  )

test('approval gate: ask -> onRequest; remember skips later asks; events in order', async () => {
  const requests: IToolApprovalRequest[] = []
  const events: AgentEvent[] = []
  const gate = createApprovalController(
    {
      mode: 'ask-all',
      onRequest: (req) => {
        requests.push(req)
        return { approved: true, remember: true }
      },
    },
    { sanitize: async (_n, input) => ({ ...(input as object), secret: '***' }) },
  )
  await inRun(events, async () => {
    await gate.gate('db__write', { secret: 'p@ss' }, { readOnly: false })
    await gate.gate('db__write', { secret: 'p@ss' }, { readOnly: false })
  })
  assert.equal(requests.length, 1, 'the remembered tool is not asked again')
  assert.deepEqual(requests[0].input, { secret: '***' }, 'the request shows the sanitized input')
  assert.equal(requests[0].runId, 'run-1')
  assert.equal(requests[0].step?.id, 's1')
  assert.deepEqual(
    events.map((e) => e.type),
    ['tool.approval-requested', 'tool.approval-resolved'],
  )
  assert.equal((events[1] as { automatic: boolean }).automatic, false)
  assert.ok(gate.remembered.has('db__write'))
})

test('approval gate: denials throw ToolDeniedError; automatic ones say so', async () => {
  const events: AgentEvent[] = []
  const noHandler = createApprovalController({ mode: 'ask-all' })
  await inRun(events, async () => {
    await assert.rejects(
      () => noHandler.gate('x', {}, { readOnly: true }),
      (err: unknown) =>
        err instanceof ToolDeniedError && /no approval handler configured/.test(err.message),
    )
  })
  assert.deepEqual(events.at(-1), {
    type: 'tool.approval-resolved',
    id: (events.at(-1) as { id: string }).id,
    name: 'x',
    approved: false,
    reason: 'no approval handler configured',
    automatic: true,
  })

  const readOnlyMode = createApprovalController({ mode: 'read-only' })
  await inRun(events, async () => {
    await readOnlyMode.gate('reader', {}, { readOnly: true })
    await assert.rejects(
      () => readOnlyMode.gate('writer', {}, { readOnly: false }),
      ToolDeniedError,
    )
  })

  const userSaysNo = createApprovalController({
    mode: 'ask-writes',
    onRequest: () => ({ approved: false, reason: 'too risky' }),
  })
  await inRun(events, async () => {
    await assert.rejects(() => userSaysNo.gate('w', {}, { readOnly: false }), /too risky/)
  })
  const last = events.at(-1) as { automatic: boolean; approved: boolean }
  assert.equal(last.approved, false)
  assert.equal(last.automatic, false)
})

test('approval gate: a timeout denies; setMode switches at runtime', async () => {
  const events: AgentEvent[] = []
  const gate = createApprovalController({
    mode: 'ask-all',
    timeoutMs: 20,
    onRequest: () => new Promise<boolean>(() => {}),
  })
  await inRun(events, async () => {
    await assert.rejects(
      () => gate.gate('slow', {}, { readOnly: false }),
      /no decision within 20ms/,
    )
  })
  gate.setMode('autopilot')
  assert.equal(gate.getMode(), 'autopilot')
  await gate.gate('slow', {}, { readOnly: false })
  assert.throws(() => gate.setMode('bogus' as never), /tool approval mode must be/)
  assert.throws(() => createApprovalController({ mode: 'nope' as never }), /toolApproval.mode/)
})

test('approval gate: built-in tools never ask', async () => {
  const gate = createApprovalController({ mode: 'ask-all', rules: { '*': 'deny' } })
  await gate.gate('load_skill', {}, { readOnly: true, builtIn: true })
})
