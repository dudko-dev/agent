import assert from 'node:assert/strict'
import test from 'node:test'
import type { SubagentInfo } from '../src/index.ts'
import { describeSubagents, parseLiveLine, resolveSubagent, shortId } from '../src/cli/live.ts'

// What a line typed WHILE a run goes means in the REPL - decided without a terminal.

test('parseLiveLine: text is said to the agent; commands that work mid-run are recognised', () => {
  assert.deepEqual(parseLiveLine('use the staging database'), {
    kind: 'say',
    text: 'use the staging database',
  })
  assert.deepEqual(parseLiveLine('  padded  '), { kind: 'say', text: 'padded' })
  assert.deepEqual(parseLiveLine(''), { kind: 'ignore' })
  assert.deepEqual(parseLiveLine('   '), { kind: 'ignore' })
  assert.deepEqual(parseLiveLine('/agents'), { kind: 'agents' })
  assert.deepEqual(parseLiveLine('/stop'), { kind: 'stop', target: '' })
  assert.deepEqual(parseLiveLine('/stop 2'), { kind: 'stop', target: '2' })
  assert.deepEqual(parseLiveLine('/stop   ab12cd  '), { kind: 'stop', target: 'ab12cd' })
})

test('parseLiveLine: a path is a message, a REPL command is not', () => {
  assert.deepEqual(parseLiveLine('/etc/hosts is the file'), {
    kind: 'say',
    text: '/etc/hosts is the file',
  })
  for (const command of ['/compact', '/history', '/reset', '/approval ask-all', '/exit']) {
    assert.deepEqual(parseLiveLine(command), { kind: 'hint' }, command)
  }
  // "/stopwatch" is not "/stop".
  assert.deepEqual(parseLiveLine('/stopwatch'), { kind: 'hint' })
})

const child = (id: string, over: Partial<SubagentInfo> = {}): SubagentInfo => ({
  id,
  name: 'analyst',
  task: 'weigh e4',
  startedAt: 1_000,
  ...over,
})

test('resolveSubagent: by number, by id prefix, or the only one - and a reason when it cannot', () => {
  const a = child('aaaa1111-0000')
  const b = child('aaaa2222-0000', { name: 'researcher' })
  const c = child('bbbb3333-0000')
  const running = [a, b, c]

  assert.equal(resolveSubagent(running, '1'), a)
  assert.equal(resolveSubagent(running, '3'), c)
  assert.equal(resolveSubagent(running, 'bbbb'), c, 'a unique prefix')
  assert.equal(resolveSubagent(running, 'aaaa2'), b)
  assert.equal(resolveSubagent([a], ''), a, 'the only one needs no target')

  assert.match(resolveSubagent([], '1') as string, /no subagent is running/)
  assert.match(resolveSubagent(running, '') as string, /3 subagents are running/)
  assert.match(resolveSubagent(running, '4') as string, /no subagent number 4/)
  assert.match(resolveSubagent(running, '0') as string, /no subagent number 0/)
  assert.match(resolveSubagent(running, 'aaaa') as string, /matches 2 subagents/)
  assert.match(resolveSubagent(running, 'zzzz') as string, /no running subagent/)
})

test('describeSubagents: one numbered line each, with age and profile', () => {
  const rows = describeSubagents(
    [child('aaaa1111-0000'), child('bbbb2222-0000', { profile: 'deep', task: 'x'.repeat(300) })],
    4_000,
  )
  assert.equal(rows.length, 2)
  assert.match(rows[0], /^ {2}1\. analyst aaaa1111 \(3s\): weigh e4$/)
  assert.match(rows[1], /^ {2}2\. analyst \[deep\] bbbb2222 \(3s\): x{100}\.\.\.$/)
  assert.equal(shortId('0123456789abcdef'), '01234567')
})
