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
