import assert from 'node:assert/strict'
import test from 'node:test'
import { filterTools, flattenContent, type IConnectedMcp } from '../src/mcp.ts'
import type { ToolSet } from 'ai'

const stubTool = (name: string): ToolSet[string] =>
  ({
    description: name,
    inputSchema: undefined as never,
    execute: async () => null,
  }) as ToolSet[string]

const fakeCatalog = (names: string[]): IConnectedMcp['catalog'] =>
  names.map((name) => ({ name, description: `desc:${name}`, server: name.split('__')[0] ?? 'srv' }))

const fakeTools = (names: string[]): ToolSet =>
  Object.fromEntries(names.map((n) => [n, stubTool(n)])) as ToolSet

test('filterTools: no filters returns the input set untouched', () => {
  const tools = fakeTools(['a__x', 'a__y'])
  const cat = fakeCatalog(['a__x', 'a__y'])
  const r = filterTools(tools, cat)
  assert.deepEqual(Object.keys(r.tools).sort(), ['a__x', 'a__y'])
  assert.equal(r.catalog.length, 2)
})

test('filterTools: allowlist wins over denylist', () => {
  const tools = fakeTools(['a__x', 'a__y', 'a__z'])
  const cat = fakeCatalog(['a__x', 'a__y', 'a__z'])
  const r = filterTools(tools, cat, ['a__x'], ['a__x', 'a__y'])
  // allow ⇒ only a__x kept; deny is ignored when allow is set.
  assert.deepEqual(Object.keys(r.tools), ['a__x'])
})

test('filterTools: denylist excludes when no allowlist given', () => {
  const tools = fakeTools(['a__x', 'a__y'])
  const cat = fakeCatalog(['a__x', 'a__y'])
  const r = filterTools(tools, cat, undefined, ['a__y'])
  assert.deepEqual(Object.keys(r.tools), ['a__x'])
})

test('filterTools: skips catalog entries with no matching tool object', () => {
  const tools = fakeTools(['a__x'])
  const cat = fakeCatalog(['a__x', 'a__missing'])
  const r = filterTools(tools, cat)
  assert.deepEqual(Object.keys(r.tools), ['a__x'])
  assert.equal(r.catalog.length, 1)
})

test('flattenContent: passes through non-array values', () => {
  assert.equal(flattenContent('hello'), 'hello')
  assert.equal(flattenContent(null), null)
  assert.deepEqual(flattenContent({ ok: true }), { ok: true })
})

test('flattenContent: joins all-text parts into a single string', () => {
  const out = flattenContent([
    { type: 'text', text: 'one' },
    { type: 'text', text: 'two' },
  ])
  assert.equal(out, 'one\ntwo')
})

test('flattenContent: returns array with mixed parts (text unwrapped)', () => {
  const image = { type: 'image', data: 'b64' }
  const out = flattenContent([{ type: 'text', text: 'one' }, image])
  assert.deepEqual(out, ['one', image])
})

test('flattenContent: does not auto-parse JSON-looking text', () => {
  // Type stability: "42" must stay a string forever.
  const out = flattenContent([{ type: 'text', text: '42' }])
  assert.equal(out, '42')
  assert.equal(typeof out, 'string')
})

test('flattenContent: empty array returns array (allText guard requires length>0)', () => {
  const out = flattenContent([])
  assert.deepEqual(out, [])
})
