import assert from 'node:assert/strict'
import test from 'node:test'
import { parseCliArgs } from '../src/cli/args.ts'

test('parses --env-file with equals form', () => {
  const args = parseCliArgs(['--env-file=.env'])
  assert.equal(args.envFile, '.env')
  assert.equal(args.help, false)
})

test('parses --env-file with separate value', () => {
  const args = parseCliArgs(['--env-file', '/tmp/.env.local'])
  assert.equal(args.envFile, '/tmp/.env.local')
})

test('parses --help and -h as boolean', () => {
  assert.equal(parseCliArgs(['--help']).help, true)
  assert.equal(parseCliArgs(['-h']).help, true)
})

test('returns help=false and envFile=undefined for empty argv', () => {
  const args = parseCliArgs([])
  assert.equal(args.help, false)
  assert.equal(args.envFile, undefined)
})

test('rejects unknown flags in strict mode', () => {
  assert.throws(() => parseCliArgs(['--bogus']))
})

test('rejects positional args', () => {
  assert.throws(() => parseCliArgs(['some-positional']))
})

test('parses CLI overrides into env-var name keys', () => {
  const args = parseCliArgs([
    '--provider=anthropic',
    '--model=claude-4-sonnet',
    '--planner-model=claude-4-haiku',
    '--log-level=debug',
    '--max-iterations=5',
    '--tool-strategy=plan-narrowed',
  ])
  assert.deepEqual(args.overrides, {
    AGENT_PROVIDER_TYPE: 'anthropic',
    AGENT_MODEL: 'claude-4-sonnet',
    AGENT_PLANNER_MODEL: 'claude-4-haiku',
    AGENT_LOG_LEVEL: 'debug',
    AGENT_MAX_ITERATIONS: '5',
    AGENT_TOOL_SELECTION_STRATEGY: 'plan-narrowed',
  })
})

test('overrides is empty when no CLI flags are passed', () => {
  const args = parseCliArgs([])
  assert.deepEqual(args.overrides, {})
})
