import assert from 'node:assert/strict'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import test from 'node:test'
import { isReadOnlyTool } from '../src/approval.ts'
import { runContext, type IRunContext } from '../src/context.ts'
import {
  createEgressTools,
  createWebFetchTool,
  htmlToText,
  WEB_FETCH_TOOL,
  type AgentEvent,
  type IEgressPolicy,
} from '../src/index.ts'

// ── html → text ──────────────────────────────────────────────────────────────

test('htmlToText: what a model reads - no scripts, styles, comments or markup; entities decoded', () => {
  const page = htmlToText(`<!doctype html><html><head><title>Docs &amp; Guides</title>
    <style>body { color: red }</style><script>alert("x")</script></head>
    <body><!-- hidden comment --><h1>Install</h1><p>Run <code>npm i</code> &lt;now&gt; &#169; &#x41;&nbsp;done.</p>
    <script type="module">const secret = 1</script><ul><li>one</li><li>two</li></ul><noscript>enable js</noscript></body></html>`)
  assert.equal(page.title, 'Docs & Guides')
  assert.match(page.text, /Install/)
  assert.match(page.text, /Run npm i <now> © A done\./)
  assert.match(page.text, /one\s+two/)
  for (const gone of [
    'alert',
    'color: red',
    'hidden comment',
    'secret',
    'enable js',
    '<script',
    '</',
    'script',
  ]) {
    assert.ok(!page.text.includes(gone), `"${gone}" is gone`)
  }
})

test('htmlToText: unknown entities and absurd code points are left alone, not crashed on', () => {
  assert.equal(htmlToText('a &unknown; b &#99999999; c').text, 'a &unknown; b &#99999999; c')
  assert.equal(htmlToText('plain text, no markup').text, 'plain text, no markup')
})

// ── the tool ─────────────────────────────────────────────────────────────────

interface ILocal {
  port: number
  hits: string[]
  close: () => Promise<void>
}
const serve = async (): Promise<ILocal> => {
  const hits: string[] = []
  const server: Server = createServer((req, res) => {
    hits.push(req.url ?? '')
    switch (req.url?.split('?')[0]) {
      case '/page':
        return void res
          .writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
          .end(
            '<html><head><title>Hello</title><script>evil()</script></head><body><p>The answer is 42.</p></body></html>',
          )
      case '/data':
        return void res
          .writeHead(200, { 'content-type': 'application/json' })
          .end('{"ok":true,"n":7}')
      case '/long':
        return void res
          .writeHead(200, { 'content-type': 'text/plain' })
          .end('abcdefghij'.repeat(5000))
      case '/image':
        return void res
          .writeHead(200, { 'content-type': 'image/png' })
          .end(Buffer.from([137, 80, 78, 71]))
      case '/missing':
        return void res.writeHead(404, { 'content-type': 'text/plain' }).end('no such thing')
      case '/latin1':
        return void res
          .writeHead(200, { 'content-type': 'text/plain; charset=iso-8859-1' })
          .end(Buffer.from([0x63, 0x61, 0x66, 0xe9]))
      default:
        return void res.end('?')
    }
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  return {
    port: (server.address() as AddressInfo).port,
    hits,
    close: () =>
      new Promise<void>((r) => {
        server.closeAllConnections()
        server.close(() => r())
      }),
  }
}
const open = (port: number, extra: IEgressPolicy = {}): IEgressPolicy => ({
  allowPrivateNetwork: true,
  protocols: ['http'],
  ports: [port],
  ...extra,
})

type Exec = (input: unknown, options: unknown) => Promise<Record<string, unknown>>
const run = async (
  policy: IEgressPolicy,
  input: { url: string; maxChars?: number },
  events: AgentEvent[] = [],
): Promise<Record<string, unknown>> => {
  const tool = createWebFetchTool({ policy }) as unknown as { execute: Exec }
  const store: IRunContext = {
    runId: 'r1',
    startedAt: 0,
    sandboxDir: '/tmp/none',
    emit: (e) => void events.push(e),
  }
  return runContext.run(store, () =>
    tool.execute(input, { toolCallId: 'c1', messages: [], abortSignal: undefined }),
  )
}

test('web_fetch: a page becomes readable text with its title; the URL reported is the final one', async () => {
  const srv = await serve()
  try {
    const r = await run(open(srv.port), { url: `http://127.0.0.1:${srv.port}/page?token=s3cret` })
    assert.equal(r.status, 200)
    assert.equal(r.title, 'Hello')
    assert.equal(r.text, 'The answer is 42.')
    assert.equal(r.contentType, 'text/html')
    assert.equal(r.truncated, false)
    assert.equal(r.untrusted, true, 'flagged as content, not instructions')
    assert.ok(!String(r.text).includes('evil'))
  } finally {
    await srv.close()
  }
})

test('web_fetch: JSON and plain text pass through; the cap truncates and says so; charset is honoured', async () => {
  const srv = await serve()
  try {
    const base = `http://127.0.0.1:${srv.port}`
    const json = await run(open(srv.port), { url: `${base}/data` })
    assert.equal(json.text, '{"ok":true,"n":7}')
    const long = await run(open(srv.port), { url: `${base}/long`, maxChars: 300 })
    assert.equal(String(long.text).length, 300)
    assert.equal(long.truncated, true)
    const latin = await run(open(srv.port), { url: `${base}/latin1` })
    assert.equal(latin.text, 'café')
  } finally {
    await srv.close()
  }
})

test('web_fetch: a non-2xx answer is returned (with its body), binary content is refused with a reason', async () => {
  const srv = await serve()
  try {
    const base = `http://127.0.0.1:${srv.port}`
    const missing = await run(open(srv.port), { url: `${base}/missing` })
    assert.deepEqual([missing.status, missing.ok, missing.text], [404, false, 'no such thing'])
    await assert.rejects(run(open(srv.port), { url: `${base}/image` }), /reads text.*image\/png/)
  } finally {
    await srv.close()
  }
})

test('web_fetch: a refusal is a tool error that says why, and is announced - without the query string', async () => {
  const events: AgentEvent[] = []
  // The defaults: loopback is refused. Nothing may reach the server.
  const srv = await serve()
  try {
    await assert.rejects(
      run(
        { protocols: ['http'], ports: [srv.port] },
        { url: `http://127.0.0.1:${srv.port}/page?token=s3cret` },
        events,
      ),
      /egress denied.*non-public address/,
    )
    assert.equal(srv.hits.length, 0)
    const e = events.find((x) => x.type === 'egress.request')
    assert.ok(e?.type === 'egress.request')
    assert.equal(e.allowed, false)
    assert.match(e.reason ?? '', /^denied-address:/)
    assert.equal(
      e.url,
      `http://127.0.0.1:${srv.port}/page`,
      'the secret in the query stays out of the log',
    )
    assert.ok(!JSON.stringify(events).includes('s3cret'))
  } finally {
    await srv.close()
  }
})

test('web_fetch: an allowed request is announced with its status', async () => {
  const events: AgentEvent[] = []
  const srv = await serve()
  try {
    await run(open(srv.port), { url: `http://127.0.0.1:${srv.port}/data?x=1` }, events)
    const e = events.find((x) => x.type === 'egress.request')
    assert.ok(e?.type === 'egress.request')
    assert.deepEqual([e.allowed, e.status, e.url], [true, 200, `http://127.0.0.1:${srv.port}/data`])
  } finally {
    await srv.close()
  }
})

test('web_fetch: read-only for the approval gate ONLY when the policy names the hosts it may reach', () => {
  // An open-internet GET is a way to leak data through the URL, so it asks like a write.
  assert.equal(isReadOnlyTool(createWebFetchTool({ policy: {} })), false)
  assert.equal(isReadOnlyTool(createWebFetchTool({ policy: { deny: ['evil.example'] } })), false)
  assert.equal(
    isReadOnlyTool(createWebFetchTool({ policy: { allow: ['docs.example.com'] } })),
    true,
  )
})

test('createEgressTools: nothing unless egress is switched on', () => {
  assert.equal(createEgressTools(undefined), undefined)
  assert.equal(createEgressTools(false), undefined)
  assert.deepEqual(Object.keys(createEgressTools(true) ?? {}), [WEB_FETCH_TOOL])
  assert.deepEqual(Object.keys(createEgressTools({ allow: ['a.example'] }) ?? {}), [WEB_FETCH_TOOL])
})
