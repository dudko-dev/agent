import assert from 'node:assert/strict'
import { mkdtemp, stat } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import {
  createNodeOAuthProvider,
  FileOAuthStore,
  finishMcpOAuth,
  MemoryOAuthStore,
} from '../src/mcp-oauth.ts'
import { connectMcpServers } from '../src/mcp.ts'
import type { IMcpServerConfig } from '../src/types.ts'

// A fake remote MCP server + authorization server behind a mock fetch. This is
// what makes the OAuth path testable at all: RFC 9728 resource metadata, AS
// metadata, RFC 7591 dynamic registration, PKCE code exchange, refresh-token
// rotation and 401-on-stale-token all happen in-process.

const MCP_ORIGIN = 'https://mcp.example.test'
const MCP_URL = `${MCP_ORIGIN}/mcp`
const AS_URL = 'https://as.example.test'
const REDIRECT_URL = 'http://127.0.0.1:8765/callback'

interface RpcMessage {
  jsonrpc: '2.0'
  id?: number | string
  method?: string
  params?: Record<string, unknown>
}

interface MockOptions {
  requireAuth?: boolean
  tools?: { name: string; description?: string; inputSchema?: unknown }[]
  failListTools?: boolean
  /** Awaited before each MCP POST is answered — used to prove overlap. */
  gate?: () => Promise<void>
  onMcpRequest?: () => void
}

const DEFAULT_TOOLS = [
  {
    name: 'echo',
    description: 'Echo the input back',
    inputSchema: { type: 'object', properties: { text: { type: 'string' } } },
  },
]

const jsonResponse = (
  body: unknown,
  status = 200,
  headers: Record<string, string> = {},
): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  })

const createMockServer = (opts: MockOptions = {}) => {
  const tools = opts.tools ?? DEFAULT_TOOLS
  const requests: { method: string; url: string; auth?: string }[] = []
  const state = {
    validTokens: new Set<string>(['access-1']),
    registrations: 0,
    grants: [] as string[],
    issued: 1,
    lastCodeVerifier: undefined as string | undefined,
    lastRegistration: undefined as Record<string, unknown> | undefined,
    /** Set to answer the next token request with invalid_client. */
    rejectClient: false,
    /** Set to answer dynamic registration with invalid_client_metadata. */
    failRegistration: false,
  }

  const handleRpc = (msg: RpcMessage): unknown => {
    if (msg.method === 'initialize') {
      return {
        jsonrpc: '2.0',
        id: msg.id,
        result: {
          protocolVersion: (msg.params as { protocolVersion: string }).protocolVersion,
          capabilities: { tools: { listChanged: true } },
          serverInfo: { name: 'mock-mcp', version: '1.0.0' },
        },
      }
    }
    if (msg.id === undefined) {
      return undefined
    }
    if (msg.method === 'tools/list') {
      if (opts.failListTools) {
        return { jsonrpc: '2.0', id: msg.id, error: { code: -32000, message: 'list exploded' } }
      }
      return { jsonrpc: '2.0', id: msg.id, result: { tools } }
    }
    if (msg.method === 'tools/call') {
      const params = (msg.params ?? {}) as { name?: string; arguments?: unknown }
      if (params.name === 'boom') {
        return {
          jsonrpc: '2.0',
          id: msg.id,
          result: { content: [{ type: 'text', text: 'kaboom' }], isError: true },
        }
      }
      return {
        jsonrpc: '2.0',
        id: msg.id,
        result: {
          content: [{ type: 'text', text: `echo:${JSON.stringify(params.arguments ?? {})}` }],
        },
      }
    }
    return { jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: 'method not found' } }
  }

  const fetchFn = async (url: string | URL, init: RequestInit = {}): Promise<Response> => {
    const href = String(url)
    const method = init.method ?? 'GET'
    const headers = new Headers((init.headers ?? {}) as Record<string, string>)
    requests.push({ method, url: href, auth: headers.get('authorization') ?? undefined })

    if (href.includes('/.well-known/oauth-protected-resource')) {
      return jsonResponse({
        resource: MCP_URL,
        authorization_servers: [AS_URL],
        scopes_supported: ['mcp:tools'],
      })
    }

    if (
      href.includes('/.well-known/oauth-authorization-server') ||
      href.includes('/.well-known/openid-configuration')
    ) {
      if (!href.startsWith(AS_URL)) {
        return new Response('not found', { status: 404 })
      }
      return jsonResponse({
        issuer: AS_URL,
        authorization_endpoint: `${AS_URL}/authorize`,
        token_endpoint: `${AS_URL}/token`,
        registration_endpoint: `${AS_URL}/register`,
        response_types_supported: ['code'],
        grant_types_supported: ['authorization_code', 'refresh_token'],
        code_challenge_methods_supported: ['S256'],
        token_endpoint_auth_methods_supported: ['none'],
      })
    }

    if (href === `${AS_URL}/register`) {
      state.registrations += 1
      const metadata = JSON.parse(String(init.body ?? '{}')) as Record<string, unknown>
      state.lastRegistration = metadata
      if (state.failRegistration) {
        return jsonResponse(
          { error: 'invalid_client_metadata', error_description: 'redirect_uri not allowed' },
          400,
        )
      }
      return jsonResponse(
        { ...metadata, client_id: `dcr-client-${state.registrations}`, client_id_issued_at: 1 },
        201,
      )
    }

    if (href === `${AS_URL}/token`) {
      const params = new URLSearchParams(String(init.body ?? ''))
      const grant = params.get('grant_type') ?? ''
      state.grants.push(grant)
      // "The client you claim to be is not registered here" — what an AS says
      // after it has forgotten (or rotated away) a dynamic registration.
      if (state.rejectClient) {
        return jsonResponse({ error: 'invalid_client' }, 401)
      }
      if (grant === 'authorization_code') {
        state.lastCodeVerifier = params.get('code_verifier') ?? undefined
        if (!state.lastCodeVerifier) {
          return jsonResponse({ error: 'invalid_request' }, 400)
        }
        if (params.get('code') !== 'auth-code-1') {
          return jsonResponse({ error: 'invalid_grant' }, 400)
        }
      } else if (
        grant === 'refresh_token' &&
        !params.get('refresh_token')?.startsWith('refresh-')
      ) {
        return jsonResponse({ error: 'invalid_grant' }, 400)
      }
      state.issued += 1
      const access = `access-${state.issued}`
      state.validTokens = new Set([access])
      return jsonResponse({
        access_token: access,
        token_type: 'Bearer',
        expires_in: 3600,
        refresh_token: `refresh-${state.issued}`,
      })
    }

    if (href.startsWith(MCP_URL)) {
      if (method === 'GET') {
        return new Response(null, { status: 405 })
      }
      if (method === 'DELETE') {
        return new Response(null, { status: 200 })
      }
      opts.onMcpRequest?.()
      if (opts.gate) {
        await opts.gate()
      }
      if (opts.requireAuth) {
        const token = (headers.get('authorization') ?? '').replace(/^Bearer\s+/i, '')
        if (!state.validTokens.has(token)) {
          return jsonResponse({ error: 'unauthorized' }, 401, {
            'www-authenticate': `Bearer resource_metadata="${MCP_ORIGIN}/.well-known/oauth-protected-resource/mcp"`,
          })
        }
      }
      const parsed = JSON.parse(String(init.body ?? 'null')) as RpcMessage | RpcMessage[]
      const messages = Array.isArray(parsed) ? parsed : [parsed]
      const replies = messages.map(handleRpc).filter((r) => r !== undefined)
      if (replies.length === 0) {
        return new Response(null, { status: 202 })
      }
      return jsonResponse(replies.length === 1 ? replies[0] : replies)
    }

    return new Response('not found', { status: 404 })
  }

  return { fetchFn, state, requests }
}

const silent = () => {}

const collect = () => {
  const lines: string[] = []
  return { log: (_l: string, m: string) => lines.push(m), lines }
}

const connect = (servers: Record<string, IMcpServerConfig>, log = silent) =>
  connectMcpServers(servers, log as never, 'agent-test')

const callTool = (
  tools: Record<string, unknown>,
  name: string,
  args: unknown,
): Promise<unknown> => {
  const tool = tools[name] as { execute: (a: unknown, o: unknown) => Promise<unknown> }
  return tool.execute(args, {})
}

const makeProvider = (store = new MemoryOAuthStore()) =>
  createNodeOAuthProvider({ serverUrl: MCP_URL, redirectUrl: REDIRECT_URL, store })

// ── connect / mount / dispatch ──────────────────────────────────────────────

test('connectMcpServers: mounts prefixed tools and dispatches through the transport', async () => {
  const mock = createMockServer()
  const mcp = await connect({ docs: { url: MCP_URL, fetch: mock.fetchFn } })

  assert.deepEqual(mcp.results, [{ name: 'docs', connected: true }])
  assert.deepEqual(Object.keys(mcp.tools), ['docs__echo'])
  assert.equal(await callTool(mcp.tools, 'docs__echo', { text: 'hi' }), 'echo:{"text":"hi"}')
  await mcp.close()
})

test('connectMcpServers: an MCP result with isError becomes a failed tool call', async () => {
  const mock = createMockServer({ tools: [{ name: 'boom', inputSchema: { type: 'object' } }] })
  const mcp = await connect({ docs: { url: MCP_URL, fetch: mock.fetchFn } })
  // Not a resolved value carrying error text: the AI SDK must see a throw, or
  // toolCalls[].ok stays true and replanAfter: 'failure' never fires.
  await assert.rejects(() => callTool(mcp.tools, 'docs__boom', {}), /kaboom/)
  await mcp.close()
})

test('connectMcpServers: tool names are sanitized into the provider-safe alphabet', async () => {
  const mock = createMockServer({
    tools: [
      { name: 'files.read', inputSchema: { type: 'object' } },
      { name: 'files/read', inputSchema: { type: 'object' } },
    ],
  })
  const mcp = await connect({ 'my docs': { url: MCP_URL, fetch: mock.fetchFn } })
  // "my docs" and both dotted/slashed tool names would be rejected outright by
  // OpenAI's ^[a-zA-Z0-9_-]{1,64}$; the collision is suffixed, not dropped.
  assert.deepEqual(Object.keys(mcp.tools), ['my_docs__files_read', 'my_docs__files_read_2'])
  assert.equal(await callTool(mcp.tools, 'my_docs__files_read_2', { a: 1 }), 'echo:{"a":1}')
  await mcp.close()
})

test('connectMcpServers: tools over the 64-char name cap are skipped with a warning', async () => {
  const mock = createMockServer({
    tools: [
      { name: 'x'.repeat(70), inputSchema: { type: 'object' } },
      { name: 'ok', inputSchema: { type: 'object' } },
    ],
  })
  const logger = collect()
  const mcp = await connect({ docs: { url: MCP_URL, fetch: mock.fetchFn } }, logger.log as never)
  assert.deepEqual(Object.keys(mcp.tools), ['docs__ok'])
  assert.ok(logger.lines.some((m) => m.includes('exceeds the 64-char limit')))
  await mcp.close()
})

test('connectMcpServers: closes the client when listTools fails after connect', async () => {
  const mock = createMockServer({ failListTools: true })
  const logger = collect()
  const mcp = await connect({ docs: { url: MCP_URL, fetch: mock.fetchFn } }, logger.log as never)
  assert.equal(mcp.results[0].connected, false)
  // Otherwise the transport (an SSE stream here, a spawned child for stdio)
  // outlives the failed connect with nothing holding a handle to it.
  assert.ok(logger.lines.some((m) => m.includes('transport closed')))
})

test('connectMcpServers: servers connect concurrently but mount in declaration order', async () => {
  let release = () => {}
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  let overlapped = false
  // "slow" blocks on the gate; "fast" opens it. If connects were sequential
  // this would stall, so the fallback timer keeps the failure a clean assert.
  const timer = setTimeout(release, 2000)
  const slow = createMockServer({
    gate: () => gate,
    tools: [{ name: 's', inputSchema: { type: 'object' } }],
  })
  const fast = createMockServer({
    tools: [{ name: 'f', inputSchema: { type: 'object' } }],
    onMcpRequest: () => {
      overlapped = true
      release()
    },
  })

  const logger = collect()
  const mcp = await connect(
    {
      slow: { url: MCP_URL, fetch: slow.fetchFn },
      fast: { url: MCP_URL, fetch: fast.fetchFn },
    },
    logger.log as never,
  )
  clearTimeout(timer)

  assert.equal(overlapped, true, 'the second server was reached before the first finished')
  assert.deepEqual(Object.keys(mcp.tools), ['slow__s', 'fast__f'], logger.lines.join(' | '))
  assert.deepEqual(
    mcp.results.map((r) => r.name),
    ['slow', 'fast'],
  )
  await mcp.close()
})

test('connectMcpServers: one broken server does not stop the others', async () => {
  const mock = createMockServer()
  const mcp = await connect({
    dead: {
      url: 'https://dead.example.test/mcp',
      fetch: async () => new Response('x', { status: 500 }),
    },
    docs: { url: MCP_URL, fetch: mock.fetchFn },
  })
  assert.equal(mcp.results.find((r) => r.name === 'dead')?.connected, false)
  assert.deepEqual(Object.keys(mcp.tools), ['docs__echo'])
  await mcp.close()
})

test('refreshServer: re-lists one server and rewrites its entries in place', async () => {
  const tools = [{ name: 'echo', inputSchema: { type: 'object' } }]
  const mock = createMockServer({ tools })
  const mcp = await connect({ docs: { url: MCP_URL, fetch: mock.fetchFn } })
  const live = mcp.tools

  tools.push({ name: 'added', inputSchema: { type: 'object' } })
  await mcp.refreshServer('docs')

  assert.equal(mcp.tools, live, 'the same object reference — a running agent sees the new tool')
  assert.deepEqual(Object.keys(live).sort(), ['docs__added', 'docs__echo'])
  await assert.rejects(() => mcp.refreshServer('nope'), /is not connected/)
  await mcp.close()
})

// ── OAuth ───────────────────────────────────────────────────────────────────

test('OAuth: an unauthenticated connect registers dynamically and asks to authorize', async () => {
  const mock = createMockServer({ requireAuth: true })
  const provider = makeProvider()
  const mcp = await connect({
    docs: { url: MCP_URL, authProvider: provider, fetch: mock.fetchFn },
  })

  assert.equal(mcp.results[0].connected, false)
  assert.equal(mcp.results[0].needsAuthorization, true)
  assert.equal(mock.state.registrations, 1, 'dynamic client registration ran')
  const url = provider.authorizationUrl
  assert.ok(url)
  assert.equal(url.searchParams.get('client_id'), 'dcr-client-1')
  assert.equal(url.searchParams.get('code_challenge_method'), 'S256')
  assert.equal(url.searchParams.get('redirect_uri'), REDIRECT_URL)
})

test('DCR: the registration request describes a public PKCE client', async () => {
  const mock = createMockServer({ requireAuth: true })
  const provider = createNodeOAuthProvider({
    serverUrl: MCP_URL,
    redirectUrl: REDIRECT_URL,
    store: new MemoryOAuthStore(),
    clientName: 'agent-test',
  })
  await connect({ docs: { url: MCP_URL, authProvider: provider, fetch: mock.fetchFn } })

  const sent = mock.state.lastRegistration
  assert.ok(sent, 'a registration body was posted')
  assert.equal(sent.client_name, 'agent-test')
  assert.deepEqual(sent.redirect_uris, [REDIRECT_URL])
  assert.deepEqual(sent.response_types, ['code'])
  // Without refresh_token in grant_types the AS may never issue one, and every
  // expiry would become an interactive re-authorization.
  assert.deepEqual(sent.grant_types, ['authorization_code', 'refresh_token'])
  // A CLI cannot keep a client_secret; PKCE is what protects the exchange.
  assert.equal(sent.token_endpoint_auth_method, 'none')
  // Scope comes from the resource metadata when the caller didn't pin one.
  assert.equal(sent.scope, 'mcp:tools')
})

test('DCR: a stored registration is reused instead of registering again', async () => {
  const mock = createMockServer({ requireAuth: true })
  const provider = makeProvider()

  await connect({ docs: { url: MCP_URL, authProvider: provider, fetch: mock.fetchFn } })
  await connect({ docs: { url: MCP_URL, authProvider: provider, fetch: mock.fetchFn } })

  assert.equal(mock.state.registrations, 1, 'a restart must not mint a second client')
  assert.equal((await provider.clientInformation())?.client_id, 'dcr-client-1')
})

test('DCR: an invalid_client response re-registers and restarts authorization', async () => {
  const mock = createMockServer({ requireAuth: true })
  const provider = makeProvider()
  // A registration the AS has since forgotten (redeployed, pruned, rotated).
  await provider.saveClientInformation({ client_id: 'forgotten-client' })
  await provider.saveTokens({
    access_token: 'access-1',
    token_type: 'Bearer',
    expires_in: 3600,
    refresh_token: 'refresh-1',
  })
  mock.state.validTokens.clear()
  mock.state.rejectClient = true

  const mcp = await connect({ docs: { url: MCP_URL, authProvider: provider, fetch: mock.fetchFn } })

  assert.equal(mcp.results[0].needsAuthorization, true)
  assert.equal(mock.state.registrations, 1, 'the dead client_id was replaced by a new registration')
  assert.equal((await provider.clientInformation())?.client_id, 'dcr-client-1')
  // Credentials tied to the dead client must go, or every later attempt
  // retries the same doomed refresh.
  assert.equal(await provider.tokens(), undefined)
  assert.equal(provider.authorizationUrl?.searchParams.get('client_id'), 'dcr-client-1')
})

test('DCR: a rejected registration surfaces the reason instead of a bare 401', async () => {
  const mock = createMockServer({ requireAuth: true })
  mock.state.failRegistration = true
  const provider = makeProvider()

  const mcp = await connect({ docs: { url: MCP_URL, authProvider: provider, fetch: mock.fetchFn } })

  assert.equal(mcp.results[0].connected, false)
  assert.match(mcp.results[0].error ?? '', /redirect_uri not allowed/)
  assert.equal(await provider.clientInformation(), undefined, 'nothing half-registered was stored')
})

test('OAuth: full flow — authorize, exchange the code, connect, call a tool', async () => {
  const mock = createMockServer({ requireAuth: true })
  const provider = makeProvider()

  await connect({ docs: { url: MCP_URL, authProvider: provider, fetch: mock.fetchFn } })
  const state = provider.authorizationUrl?.searchParams.get('state') ?? undefined
  await finishMcpOAuth(provider, { code: 'auth-code-1', state }, { fetch: mock.fetchFn })
  assert.ok(mock.state.lastCodeVerifier, 'the exchange carried the PKCE verifier')

  const mcp = await connect({
    docs: { url: MCP_URL, authProvider: provider, fetch: mock.fetchFn },
  })
  assert.equal(mcp.results[0].connected, true)
  assert.equal(await callTool(mcp.tools, 'docs__echo', { text: 'hi' }), 'echo:{"text":"hi"}')
  const posts = mock.requests.filter((r) => r.method === 'POST' && r.url.startsWith(MCP_URL))
  assert.equal(posts.at(-1)?.auth, 'Bearer access-2')
  await mcp.close()
})

test('OAuth: rejects a callback whose state does not match', async () => {
  const provider = makeProvider()
  await provider.state()
  await assert.rejects(
    () => finishMcpOAuth(provider, { code: 'auth-code-1', state: 'forged' }),
    /state mismatch/,
  )
})

test('OAuth: a token that expires mid-session is refreshed and the call retried', async () => {
  const mock = createMockServer({ requireAuth: true })
  const provider = makeProvider()
  await provider.saveClientInformation({ client_id: 'dcr-client-1' })
  await provider.saveTokens({
    access_token: 'access-1',
    token_type: 'Bearer',
    expires_in: 3600,
    refresh_token: 'refresh-1',
  })

  const mcp = await connect({
    docs: { url: MCP_URL, authProvider: provider, fetch: mock.fetchFn },
  })
  assert.equal(mcp.results[0].connected, true)

  mock.state.validTokens.clear() // the server now rejects what we hold
  assert.equal(await callTool(mcp.tools, 'docs__echo', { text: 'x' }), 'echo:{"text":"x"}')
  assert.ok(mock.state.grants.includes('refresh_token'))
  assert.equal((await provider.tokens())?.access_token, 'access-2')
  await mcp.close()
})

test('OAuth: an already-expired token is refreshed before the first request', async () => {
  const mock = createMockServer({ requireAuth: true })
  const provider = makeProvider()
  await provider.saveClientInformation({ client_id: 'dcr-client-1' })
  await provider.saveTokens({
    access_token: 'access-1',
    token_type: 'Bearer',
    expires_in: 5, // inside the 30s skew: known dead before we connect
    refresh_token: 'refresh-1',
  })
  mock.state.validTokens.clear()

  const mcp = await connect({
    docs: { url: MCP_URL, authProvider: provider, fetch: mock.fetchFn },
  })
  assert.equal(mcp.results[0].connected, true)
  const posts = mock.requests.filter((r) => r.method === 'POST' && r.url.startsWith(MCP_URL))
  assert.ok(posts.length > 0)
  assert.ok(
    posts.every((r) => r.auth === 'Bearer access-2'),
    'no request was ever sent with the dead token',
  )
  await mcp.close()
})

test('OAuth: a dead refresh token clears the tokens and asks to authorize again', async () => {
  const mock = createMockServer({ requireAuth: true })
  const provider = makeProvider()
  await provider.saveClientInformation({ client_id: 'dcr-client-1' })
  await provider.saveTokens({
    access_token: 'access-1',
    token_type: 'Bearer',
    expires_in: 3600,
    refresh_token: 'bogus',
  })
  mock.state.validTokens.clear()

  const mcp = await connect({
    docs: { url: MCP_URL, authProvider: provider, fetch: mock.fetchFn },
  })
  assert.equal(mcp.results[0].needsAuthorization, true)
  assert.equal(await provider.tokens(), undefined)
})

// ── provider + stores ───────────────────────────────────────────────────────

test('NodeOAuthProvider: expiry honours the skew, and an absent expires_in waits for a 401', async () => {
  const provider = makeProvider()
  assert.equal(await provider.isAccessTokenExpired(), true)

  await provider.saveTokens({ access_token: 'a', token_type: 'Bearer', expires_in: 3600 })
  assert.equal(await provider.isAccessTokenExpired(), false)
  assert.equal(await provider.isAuthorized(), true)

  await provider.saveTokens({ access_token: 'b', token_type: 'Bearer', expires_in: 10 })
  assert.equal(await provider.isAccessTokenExpired(), true)

  await provider.saveTokens({ access_token: 'c', token_type: 'Bearer' })
  assert.equal(await provider.isAccessTokenExpired(), false)
})

test('NodeOAuthProvider: state is single-use', async () => {
  const provider = makeProvider()
  const issued = await provider.state()
  assert.equal(await provider.verifyState(issued), true)
  assert.equal(await provider.verifyState(issued), false)
})

test('NodeOAuthProvider: invalidateCredentials drops only the requested scope', async () => {
  const provider = makeProvider()
  await provider.saveTokens({ access_token: 'a', token_type: 'Bearer' })
  await provider.saveClientInformation({ client_id: 'c1' })

  await provider.invalidateCredentials('tokens')
  assert.equal(await provider.tokens(), undefined)
  assert.deepEqual(await provider.clientInformation(), { client_id: 'c1' })

  await provider.reset()
  assert.equal(await provider.clientInformation(), undefined)
})

test('NodeOAuthProvider: refuses a plaintext http server that is not loopback', () => {
  assert.throws(
    () =>
      createNodeOAuthProvider({
        serverUrl: 'http://mcp.example.test/mcp',
        redirectUrl: REDIRECT_URL,
        store: new MemoryOAuthStore(),
      }),
    /requires https/,
  )
})

test('FileOAuthStore: round-trips values and keeps the file owner-only', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'agent-oauth-'))
  const file = path.join(dir, 'nested', 'tokens.json')
  const store = new FileOAuthStore(file)

  await store.set('a', 'one')
  await store.set('b', 'two')
  assert.equal(await store.get('a'), 'one')

  // Tokens are bearer credentials: anything that can read the file is the user.
  assert.equal((await stat(file)).mode & 0o777, 0o600)

  await store.delete('a')
  assert.equal(await store.get('a'), undefined)
  assert.equal(await store.get('b'), 'two')
  assert.equal(await store.get('missing'), undefined)
})

test('FileOAuthStore: concurrent writes do not clobber each other', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'agent-oauth-'))
  const store = new FileOAuthStore(path.join(dir, 'tokens.json'))

  await Promise.all(Array.from({ length: 8 }, (_, i) => store.set(`k${i}`, `v${i}`)))
  for (let i = 0; i < 8; i++) {
    assert.equal(await store.get(`k${i}`), `v${i}`)
  }
})
