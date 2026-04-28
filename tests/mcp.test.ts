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

test('flattenContent: passes through non-array values', async () => {
  assert.equal(await flattenContent('hello'), 'hello')
  assert.equal(await flattenContent(null), null)
  assert.deepEqual(await flattenContent({ ok: true }), { ok: true })
})

test('flattenContent: joins all-text parts into a single string', async () => {
  const out = await flattenContent([
    { type: 'text', text: 'one' },
    { type: 'text', text: 'two' },
  ])
  assert.equal(out, 'one\ntwo')
})

test('flattenContent: returns array with mixed parts (text unwrapped) when no sandbox', async () => {
  const image = { type: 'image', data: 'b64' }
  const out = await flattenContent([{ type: 'text', text: 'one' }, image])
  assert.deepEqual(out, ['one', image])
})

test('flattenContent: does not auto-parse JSON-looking text', async () => {
  const out = await flattenContent([{ type: 'text', text: '42' }])
  assert.equal(out, '42')
  assert.equal(typeof out, 'string')
})

test('flattenContent: empty array returns array (allText guard requires length>0)', async () => {
  const out = await flattenContent([])
  assert.deepEqual(out, [])
})

test('flattenContent: spills image base64 to sandbox and returns a file ref', async () => {
  const { mkdtempSync, rmSync, readFileSync, existsSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const path = await import('node:path')
  const sandboxDir = mkdtempSync(path.join(tmpdir(), 'agent-test-'))
  try {
    const png = Buffer.from('hello-binary')
    const data = png.toString('base64')
    const out = (await flattenContent(
      [
        { type: 'text', text: 'see attached' },
        { type: 'image', data, mimeType: 'image/png' },
      ],
      { toolName: 'srv__draw', sandboxDir },
    )) as unknown[]
    assert.equal(out[0], 'see attached')
    const ref = out[1] as {
      type: string
      kind: string
      path: string
      mimeType: string
      bytes: number
    }
    assert.equal(ref.type, 'file')
    assert.equal(ref.kind, 'image')
    assert.equal(ref.mimeType, 'image/png')
    assert.equal(ref.bytes, png.byteLength)
    assert.match(ref.path, /\.png$/)
    assert.equal(existsSync(ref.path), true)
    assert.deepEqual(readFileSync(ref.path), png)
  } finally {
    rmSync(sandboxDir, { recursive: true, force: true })
  }
})

test('flattenContent: passes binary parts through untouched when sandboxDir is omitted', async () => {
  const audio = { type: 'audio', data: 'b64payload', mimeType: 'audio/mp3' }
  const out = await flattenContent([{ type: 'text', text: 'clip' }, audio])
  assert.deepEqual(out, ['clip', audio])
})

test('flattenContent: unwraps embedded text resource even with sandbox configured', async () => {
  const { mkdtempSync, rmSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const path = await import('node:path')
  const sandboxDir = mkdtempSync(path.join(tmpdir(), 'agent-test-'))
  try {
    const out = await flattenContent(
      [
        {
          type: 'resource',
          resource: { uri: 'file:///x', mimeType: 'text/plain', text: 'hello' },
        },
      ],
      { toolName: 'srv__read', sandboxDir },
    )
    assert.deepEqual(out, ['hello'])
  } finally {
    rmSync(sandboxDir, { recursive: true, force: true })
  }
})
