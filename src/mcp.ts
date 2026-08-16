import {
  auth,
  UnauthorizedError,
  type OAuthClientProvider,
} from '@modelcontextprotocol/sdk/client/auth.js'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import {
  getDefaultEnvironment,
  StdioClientTransport,
} from '@modelcontextprotocol/sdk/client/stdio.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import type { FetchLike, Transport } from '@modelcontextprotocol/sdk/shared/transport.js'
import { ToolListChangedNotificationSchema } from '@modelcontextprotocol/sdk/types.js'
import { dynamicTool, jsonSchema, type ToolSet } from 'ai'
import { randomUUID } from 'node:crypto'
import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { URL } from 'node:url'
import packageJson from '../package.json' with { type: 'json' }
import { getCurrentRunSandbox } from './context.ts'
import { assertSecureOAuthUrl } from './mcp-oauth.ts'
import { ATTR, withSpan } from './tracing.ts'
import type { IMcpServerConfig } from './types.ts'

const isStdioConfig = (
  cfg: IMcpServerConfig,
): cfg is Extract<IMcpServerConfig, { command: string }> => 'command' in cfg && !!cfg.command

const isHttpConfig = (cfg: IMcpServerConfig): cfg is Extract<IMcpServerConfig, { url: string }> =>
  'url' in cfg && !!cfg.url

const CLIENT_VERSION = (packageJson as { version: string }).version

// Provider-side tool-name limit. OpenAI rejects tool names longer than 64
// chars (regex: ^[a-zA-Z0-9_-]{1,64}$); Anthropic and Gemini are at most as
// permissive. We enforce the same cap on the prefixed `serverName__toolName`
// so a single misconfigured server can't poison the whole run with an
// invalid tool name.
const MAX_TOOL_NAME_LEN = 64

// The same providers also reject anything outside [a-zA-Z0-9_-], and MCP names
// are free to contain dots, slashes or spaces. Map them into the allowed
// alphabet; callTool still uses the ORIGINAL name from the server.
const sanitizeName = (s: string): string => s.replace(/[^a-zA-Z0-9_-]/g, '_')

// Sanitizing can collapse two distinct names onto one key ("a.b" and "a/b" both
// become "a_b"). Suffix instead of dropping: a tool the model cannot see is a
// silent capability loss.
const uniqueKey = (base: string, taken: ToolSet): string => {
  if (!taken[base]) {
    return base
  }
  for (let n = 2; n < 100; n++) {
    const suffix = `_${n}`
    const candidate = base.slice(0, MAX_TOOL_NAME_LEN - suffix.length) + suffix
    if (!taken[candidate]) {
      return candidate
    }
  }
  return ''
}

/**
 * Raised for a tool result carrying `isError`. `toJSON` matters: the AI SDK
 * puts the thrown value verbatim on the tool-error part, which ends up in
 * `IStepResult.toolCalls[].output` and therefore in whatever an `IPersistence`
 * serialises — and `JSON.stringify(new Error('boom'))` is `{}`, losing the one
 * piece of information the server sent.
 */
export class McpToolError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'McpToolError'
  }

  toJSON(): string {
    return this.message
  }
}

// The subset of the MCP tool descriptor we mount from.
interface IMcpToolDescriptor {
  name: string
  description?: string
  inputSchema: unknown
}

interface IServerConnect {
  name: string
  client?: Client
  listed?: IMcpToolDescriptor[]
  error?: string
  needsAuthorization?: boolean
}

/** Thrown by the refresh-only view when the SDK reaches for a redirect. */
class RefreshOnlyAbort extends Error {}

/**
 * A view of the provider that can renew a token but can never start an
 * interactive authorization.
 *
 * `auth()` has no refresh-only mode: when a refresh fails for a reason it deems
 * recoverable (a 5xx from the token endpoint, a network blip) it falls straight
 * through to a brand-new authorization — issuing a state and a PKCE verifier,
 * overwriting the stored pair, and calling `redirectToAuthorization`. So a
 * 30-second outage at the authorization server would tell an operator to
 * re-authorize a session whose refresh token is perfectly good, and the
 * transport's own `auth()` on the first 401 would then overwrite that state
 * again, leaving the operator with a code the stored pair cannot verify.
 * Blocking the three redirect-path methods aborts the escalation before
 * anything is overwritten.
 */
const refreshOnly = (p: OAuthClientProvider): OAuthClientProvider => ({
  // Must stay truthy: `auth()` reads a missing redirectUrl as "non-interactive
  // grant" and would try to fetch a token without one.
  get redirectUrl() {
    return p.redirectUrl
  },
  get clientMetadata() {
    return p.clientMetadata
  },
  clientInformation: () => p.clientInformation(),
  saveClientInformation: p.saveClientInformation?.bind(p),
  tokens: () => p.tokens(),
  saveTokens: (t) => p.saveTokens(t),
  invalidateCredentials: p.invalidateCredentials?.bind(p),
  addClientAuthentication: p.addClientAuthentication?.bind(p),
  validateResourceURL: p.validateResourceURL?.bind(p),
  codeVerifier: () => p.codeVerifier(),
  state: () => {
    throw new RefreshOnlyAbort()
  },
  saveCodeVerifier: () => {
    throw new RefreshOnlyAbort()
  },
  redirectToAuthorization: () => {
    throw new RefreshOnlyAbort()
  },
})

/**
 * An access token that is already expired produces a guaranteed 401 on the
 * first request. When the provider can tell us so AND we hold a refresh token,
 * renew before connecting: one round-trip saved, and a run doesn't open with a
 * spurious auth failure.
 *
 * Best-effort by design — anything that goes wrong here is left to the
 * transport's own 401 handling, which is the single owner of asking a human to
 * authorize again.
 */
const refreshIfExpired = async (
  provider: OAuthClientProvider,
  serverUrl: string,
  fetchFn: FetchLike | undefined,
  log: (level: 'info' | 'warn' | 'error', message: string) => void,
  name: string,
): Promise<void> => {
  const check = (provider as { isAccessTokenExpired?: () => boolean | Promise<boolean> })
    .isAccessTokenExpired
  if (typeof check !== 'function') {
    return
  }
  if (!(await check.call(provider))) {
    return
  }
  const tokens = await provider.tokens()
  if (!tokens?.refresh_token) {
    return
  }
  try {
    await auth(refreshOnly(provider), { serverUrl, fetchFn })
  } catch (err) {
    log(
      'info',
      err instanceof RefreshOnlyAbort
        ? `[mcp] ${name}: the stored token could not be refreshed; a new authorization is needed`
        : `[mcp] ${name}: proactive token refresh failed (${(err as Error).message}); continuing`,
    )
  }
}

export interface IConnectedMcp {
  // Live, mutable maps. When a server pushes notifications/tools/list_changed
  // and the agent calls refreshServer(), entries for that server are rewritten
  // in place. Callers should always read through these references rather than
  // caching their own snapshot.
  tools: ToolSet
  catalog: { name: string; description: string; server: string }[]
  close: () => Promise<void>
  // Per-server connect outcome so the caller can decide whether to fail hard
  // (e.g. when every configured server failed and the agent would otherwise
  // start with zero tools). `needsAuthorization` marks the one failure a host
  // can actually act on: the server wants OAuth and the configured
  // authProvider has no usable token yet.
  results: { name: string; connected: boolean; error?: string; needsAuthorization?: boolean }[]
  // Re-fetch one server's tool list and rewrite its entries in tools/catalog.
  // Throws if the server is not connected.
  refreshServer: (name: string) => Promise<void>
}

export const connectMcpServers = async (
  servers: Record<string, IMcpServerConfig>,
  log: (level: 'info' | 'warn' | 'error', message: string) => void,
  clientName: string,
  outputSanitizer?: (toolName: string, output: unknown) => unknown | Promise<unknown>,
  // Fires when an MCP server pushes notifications/tools/list_changed. The
  // handler MUST NOT mutate tools/catalog directly (a run may be in flight
  // and reading ctx.tools); instead it should schedule a deferred
  // refreshServer() call from a safe quiescent point.
  onToolsChanged?: (server: string) => void,
  // Sanitizes args before they reach the MCP server (and after the executor
  // already sanitized them for event emission - idempotency is documented
  // and required).
  inputSanitizer?: (toolName: string, input: unknown) => unknown | Promise<unknown>,
): Promise<IConnectedMcp> => {
  const clients = new Map<string, Client>()
  const tools: ToolSet = {}
  const catalog: IConnectedMcp['catalog'] = []
  const results: IConnectedMcp['results'] = []
  // server name -> the tool keys it currently owns, so a refresh removes
  // exactly its own entries.
  const mountedKeys = new Map<string, string[]>()

  const mountServerTools = (name: string, client: Client, listed: IMcpToolDescriptor[]): void => {
    const serverPrefix = `${sanitizeName(name)}__`
    // Drop existing entries for this server before re-listing. We mutate in
    // place so external references to `tools` and `catalog` stay valid.
    //
    // Delete the keys this server actually mounted, NOT everything sharing its
    // prefix: sanitizing can make two server names collapse onto one prefix
    // ("a.b" and "a/b"), and one server's prefix can nest inside another's
    // ("a" and "a__b"). A prefix sweep would unmount a DIFFERENT server's
    // tools while leaving its catalogue rows behind.
    for (const k of mountedKeys.get(name) ?? []) {
      delete tools[k]
    }
    for (let i = catalog.length - 1; i >= 0; i--) {
      if (catalog[i].server === name) {
        catalog.splice(i, 1)
      }
    }
    const keys: string[] = []

    let mounted = 0
    let skipped = 0
    for (const t of listed) {
      const candidate = serverPrefix + sanitizeName(t.name)
      if (candidate.length > MAX_TOOL_NAME_LEN) {
        log(
          'warn',
          `[mcp] ${name}: tool "${t.name}" prefixed name (${candidate.length} chars) exceeds the ${MAX_TOOL_NAME_LEN}-char limit enforced by major LLM providers; skipping`,
        )
        skipped++
        continue
      }
      const prefixed = uniqueKey(candidate, tools)
      if (!prefixed) {
        log('warn', `[mcp] ${name}: no free name left for tool "${t.name}"; skipping`)
        skipped++
        continue
      }
      if (prefixed !== candidate) {
        log(
          'warn',
          `[mcp] ${name}: tool name "${candidate}" already taken; mounted as "${prefixed}"`,
        )
      }
      const description = t.description ?? ''
      tools[prefixed] = dynamicTool({
        description,
        inputSchema: jsonSchema(t.inputSchema as Parameters<typeof jsonSchema>[0]),
        execute: async (args, opts) =>
          withSpan(
            'agent.tool_call',
            { [ATTR.TOOL_NAME]: prefixed },
            async (span): Promise<unknown> => {
              let toSend: Record<string, unknown> = (args ?? {}) as Record<string, unknown>
              if (inputSanitizer) {
                try {
                  const sanitized = await inputSanitizer(prefixed, toSend)
                  // The sanitizer can return any shape; coerce non-objects to a
                  // wrapper so the MCP "arguments" field stays a JSON object.
                  toSend =
                    sanitized && typeof sanitized === 'object' && !Array.isArray(sanitized)
                      ? (sanitized as Record<string, unknown>)
                      : { value: sanitized }
                } catch (err) {
                  log(
                    'warn',
                    `[mcp] ${prefixed}: inputSanitizer threw - ${(err as Error).message}; input replaced with placeholder`,
                  )
                  toSend = { _redacted: 'inputSanitizer failed' }
                }
              }
              let result
              try {
                result = await client.callTool(
                  { name: t.name, arguments: toSend },
                  undefined,
                  opts?.abortSignal ? { signal: opts.abortSignal } : undefined,
                )
              } catch (err) {
                span.setAttribute(ATTR.TOOL_OK, false)
                throw err
              }
              // outputSanitizer runs BEFORE flattenContent so the user can
              // redact the raw MCP content (including image/audio base64 data
              // that would otherwise be spilled to disk before sanitisation).
              // Caller wanting post-spill redaction can sanitise the file path
              // they receive in the model-facing output - this order favors
              // privacy by default.
              // An MCP failure is a NORMAL response carrying isError, not a
              // transport error. It has to end in a throw so the AI SDK records
              // a failed tool call (ok: false) instead of feeding the error
              // text to the model as a successful result — which is also what
              // keeps replanAfter: 'failure' able to see it. Read the flag
              // before sanitisation, so a sanitizer that throws cannot turn a
              // failure back into a success.
              const isError = result.isError === true
              let raw: unknown = result.content
              if (outputSanitizer) {
                try {
                  raw = await outputSanitizer(prefixed, raw)
                } catch (err) {
                  log(
                    'warn',
                    `[mcp] ${prefixed}: outputSanitizer threw - ${(err as Error).message}; output replaced with placeholder`,
                  )
                  span.setAttribute(ATTR.TOOL_OK, false)
                  if (isError) {
                    throw new McpToolError('[output redacted: sanitizer failed]')
                  }
                  return '[output redacted: sanitizer failed]'
                }
              }
              const flat = await flattenContent(raw, {
                toolName: prefixed,
                // Resolved per-call so concurrent runs spill into their own
                // per-runId subdirs. undefined when called outside of a run
                // (defensive; in practice every tool call sits inside runAgentLoop).
                // Failed calls never spill: the files would be orphaned, since
                // the model only ever sees the thrown message.
                sandboxDir: isError ? undefined : getCurrentRunSandbox(),
              })
              if (isError) {
                span.setAttribute(ATTR.TOOL_OK, false)
                const text = typeof flat === 'string' ? flat : JSON.stringify(flat)
                throw new McpToolError(
                  text && text !== '[]'
                    ? text
                    : `MCP tool "${t.name}" reported an error with no content`,
                )
              }
              span.setAttribute(ATTR.TOOL_OK, true)
              return flat
            },
          ),
      })
      catalog.push({ name: prefixed, description, server: name })
      keys.push(prefixed)
      mounted++
    }
    mountedKeys.set(name, keys)
    if (skipped > 0) {
      log('info', `[mcp] ${name}: ${mounted} tools mounted, ${skipped} skipped (length cap)`)
    } else {
      log('info', `[mcp] ${name}: ${mounted} tools mounted`)
    }
  }

  const registerServerTools = async (name: string, client: Client): Promise<void> => {
    mountServerTools(name, client, (await client.listTools()).tools as IMcpToolDescriptor[])
  }

  const openConnection = async (name: string, cfg: IMcpServerConfig): Promise<IServerConnect> => {
    let client: Client | undefined
    try {
      let transport: Transport
      if (isStdioConfig(cfg)) {
        // stdio: spawn the configured executable; the SDK pipes JSON-RPC
        // over the child's stdin/stdout.
        //
        // Env merge: the SDK replaces (does NOT merge) when `env` is given,
        // which means a user passing { DEBUG: '1' } loses PATH, HOME, etc.
        // and the child can't find binaries on PATH. We merge here on top
        // of getDefaultEnvironment() (the safe inheritance subset) so user
        // additions are additive, not replacing.
        const mergedEnv = cfg.env ? { ...getDefaultEnvironment(), ...cfg.env } : undefined
        transport = new StdioClientTransport({
          command: cfg.command,
          args: cfg.args,
          env: mergedEnv,
          cwd: cfg.cwd,
        })
      } else if (isHttpConfig(cfg)) {
        if (cfg.headers && cfg.getHeaders) {
          throw new Error(`MCP server "${name}": specify either headers or getHeaders, not both`)
        }
        const headers = cfg.getHeaders ? await cfg.getHeaders() : cfg.headers
        if (cfg.authProvider) {
          if (headers && 'Authorization' in headers) {
            log(
              'warn',
              `[mcp] ${name}: an explicit Authorization header shadows the OAuth token from authProvider`,
            )
          }
          // The provider guards its own serverUrl, but the transport talks to
          // cfg.url — guard that too, or a config pairing an https provider
          // with an http endpoint posts bearer tokens in cleartext.
          assertSecureOAuthUrl(cfg.url, `MCP server "${name}"`)
          await refreshIfExpired(cfg.authProvider, cfg.url, cfg.fetch, log, name)
        }
        transport = new StreamableHTTPClientTransport(new URL(cfg.url), {
          requestInit: headers ? { headers } : undefined,
          // With an authProvider the SDK attaches the access token, refreshes
          // it on a 401 and retries the request - the one thing a static
          // header can never do.
          authProvider: cfg.authProvider,
          fetch: cfg.fetch,
          // Built-in reconnect for transient SSE drops. Defaults are conservative;
          // production deployments should tune via direct transport access if needed.
          reconnectionOptions: {
            maxReconnectionDelay: 30_000,
            initialReconnectionDelay: 1_000,
            reconnectionDelayGrowFactor: 1.5,
            maxRetries: 5,
          },
        })
      } else {
        throw new Error(
          `MCP server "${name}": config must specify either { url } (HTTP) or { command } (stdio)`,
        )
      }
      transport.onerror = (err) => log('warn', `[mcp] ${name}: transport error - ${err.message}`)
      transport.onclose = () => log('warn', `[mcp] ${name}: transport closed`)

      client = new Client({ name: clientName, version: CLIENT_VERSION })
      await client.connect(transport)

      // Subscribe BEFORE the first list call: a server that mutates its tool
      // set during init would otherwise lose the notification in the small
      // window between connect() and listTools().
      if (onToolsChanged) {
        client.setNotificationHandler(ToolListChangedNotificationSchema, () => {
          onToolsChanged(name)
        })
      }

      return { name, client, listed: (await client.listTools()).tools as IMcpToolDescriptor[] }
    } catch (err) {
      // The client may be live even though we ended up here (listTools failing
      // after a successful connect). Close it, or the transport - an SSE stream
      // or a spawned child process - outlives the failed connect.
      if (client) {
        await client.close().catch(() => {})
      }
      const message = (err as Error).message
      const needsAuthorization = err instanceof UnauthorizedError
      log(
        'error',
        needsAuthorization
          ? `[mcp] ${name}: authorization required - complete the OAuth flow and reconnect`
          : `[mcp] ${name}: failed to connect - ${message}`,
      )
      return { name, error: message, needsAuthorization }
    }
  }

  // Servers connect concurrently (a slow or hanging server no longer delays
  // every server after it), but mount in declaration order so the resulting
  // tool set and catalogue stay deterministic.
  const opened = await Promise.all(
    Object.entries(servers).map(([name, cfg]) => openConnection(name, cfg)),
  )

  for (const server of opened) {
    if (!server.client || !server.listed) {
      results.push({
        name: server.name,
        connected: false,
        error: server.error,
        ...(server.needsAuthorization ? { needsAuthorization: true } : {}),
      })
      continue
    }
    clients.set(server.name, server.client)
    mountServerTools(server.name, server.client, server.listed)
    results.push({ name: server.name, connected: true })
  }

  return {
    tools,
    catalog,
    results,
    close: async () => {
      await Promise.allSettled([...clients.values()].map((c) => c.close()))
    },
    refreshServer: async (name: string) => {
      const client = clients.get(name)
      if (!client) {
        throw new Error(`MCP server "${name}" is not connected`)
      }
      await registerServerTools(name, client)
    },
  }
}

// Map common MCP mimeTypes to file extensions. Falls back to a generic
// extension keyed by the part kind so the file at least carries a hint for
// downstream tools.
const FALLBACK_EXT = { image: '.bin', audio: '.bin', resource: '.bin' } as const

const extFromMime = (mime: string | undefined, kind: keyof typeof FALLBACK_EXT): string => {
  if (!mime) {
    return FALLBACK_EXT[kind]
  }
  const slash = mime.indexOf('/')
  const sub = slash >= 0 ? mime.slice(slash + 1) : mime
  const cleaned = sub.split(';')[0].trim().toLowerCase()
  if (!cleaned || /[^a-z0-9.+-]/.test(cleaned)) {
    return FALLBACK_EXT[kind]
  }
  // Common subtypes carry vendor prefixes (e.g. "vnd.openxmlformats..."); we
  // keep the simple short form for the popular ones, fallback to the cleaned
  // subtype for the rest.
  const map: Record<string, string> = {
    jpeg: '.jpg',
    jpg: '.jpg',
    png: '.png',
    gif: '.gif',
    webp: '.webp',
    svg: '.svg',
    'svg+xml': '.svg',
    mp3: '.mp3',
    mpeg: '.mp3',
    wav: '.wav',
    'x-wav': '.wav',
    ogg: '.ogg',
    pdf: '.pdf',
    json: '.json',
    plain: '.txt',
    html: '.html',
    csv: '.csv',
  }
  return map[cleaned] ?? `.${cleaned.replace(/\+/g, '-')}`
}

const SAFE_NAME = /[^a-zA-Z0-9_-]/g

interface ISpilledRef {
  type: 'file'
  kind: 'image' | 'audio' | 'resource'
  path: string
  mimeType?: string
  bytes: number
  uri?: string
}

const spillBase64 = async (
  data: string,
  mimeType: string | undefined,
  kind: ISpilledRef['kind'],
  toolName: string,
  sandboxDir: string,
  ensureDir: () => Promise<void>,
): Promise<ISpilledRef> => {
  await ensureDir()
  const ext = extFromMime(mimeType, kind)
  const safe = toolName.replace(SAFE_NAME, '_').slice(0, 32) || 'tool'
  const id = randomUUID().slice(0, 8)
  const fullPath = path.join(sandboxDir, `${kind}-${safe}-${id}${ext}`)
  const buf = Buffer.from(data, 'base64')
  await writeFile(fullPath, buf)
  return { type: 'file', kind, path: fullPath, mimeType, bytes: buf.byteLength }
}

// Async because spilling binary parts to the sandbox involves disk I/O. Pure
// text content (the common case) returns synchronously-computed values via a
// resolved promise, so the await cost is negligible.
//
// Unknown / non-binary parts pass through unchanged: the previous behavior
// (text concatenation when ALL parts are text, otherwise array of unwrapped
// strings + raw objects) is preserved bit-for-bit.
export const flattenContent = async (
  content: unknown,
  context?: { toolName: string; sandboxDir?: string },
): Promise<unknown> => {
  if (!Array.isArray(content)) {
    return content
  }
  const parts = content as Array<Record<string, unknown>>
  const allText =
    parts.length > 0 && parts.every((p) => p?.type === 'text' && typeof p.text === 'string')
  if (allText) {
    return parts.map((p) => p.text as string).join('\n')
  }
  const sandboxDir = context?.sandboxDir
  const toolName = context?.toolName ?? 'tool'
  // mkdir-once: when a tool result has many binary parts, spillBase64 used
  // to mkdir() per part. Cache a single mkdir promise per flattenContent
  // call so we make at most one syscall regardless of part count.
  let mkdirOnce: Promise<void> | undefined
  const ensureDir = (): Promise<void> => {
    if (!sandboxDir) {
      return Promise.resolve()
    }
    if (!mkdirOnce) {
      mkdirOnce = mkdir(sandboxDir, { recursive: true }).then(() => undefined)
    }
    return mkdirOnce
  }
  const out: unknown[] = []
  for (const p of parts) {
    if (p?.type === 'text' && typeof p.text === 'string') {
      out.push(p.text)
      continue
    }
    if (sandboxDir && (p?.type === 'image' || p?.type === 'audio') && typeof p.data === 'string') {
      const ref = await spillBase64(
        p.data,
        typeof p.mimeType === 'string' ? p.mimeType : undefined,
        p.type as 'image' | 'audio',
        toolName,
        sandboxDir,
        ensureDir,
      )
      out.push(ref)
      continue
    }
    if (sandboxDir && p?.type === 'resource' && p.resource && typeof p.resource === 'object') {
      const r = p.resource as { blob?: unknown; text?: unknown; mimeType?: unknown; uri?: unknown }
      if (typeof r.blob === 'string') {
        const ref = await spillBase64(
          r.blob,
          typeof r.mimeType === 'string' ? r.mimeType : undefined,
          'resource',
          toolName,
          sandboxDir,
          ensureDir,
        )
        if (typeof r.uri === 'string') {
          ref.uri = r.uri
        }
        out.push(ref)
        continue
      }
      if (typeof r.text === 'string') {
        out.push(r.text)
        continue
      }
    }
    out.push(p)
  }
  return out
}

export const filterTools = (
  tools: ToolSet,
  catalog: IConnectedMcp['catalog'],
  available?: string[],
  excluded?: string[],
  log?: (level: 'info' | 'warn' | 'error', message: string) => void,
): { tools: ToolSet; catalog: IConnectedMcp['catalog'] } => {
  // Catalogue names are sanitized ("my.docs__files.read" mounts as
  // "my_docs__files_read"), so raw configured names would silently match
  // nothing: an allowlist would yield zero tools, and — worse — a denylist
  // would stop denying. Compare on the sanitized form, and say so when an
  // entry matches nothing at all.
  const allow = available?.length ? new Set(available.map(sanitizeName)) : null
  const deny = excluded?.length ? new Set(excluded.map(sanitizeName)) : null
  const matched = new Set<string>()

  const result: ToolSet = {}
  const filteredCatalog: IConnectedMcp['catalog'] = []

  for (const entry of catalog) {
    if (allow?.has(entry.name) || deny?.has(entry.name)) {
      matched.add(entry.name)
    }
    if (allow && !allow.has(entry.name)) {
      continue
    }
    if (!allow && deny?.has(entry.name)) {
      continue
    }
    const t = tools[entry.name]
    if (!t) {
      continue
    }
    result[entry.name] = t
    filteredCatalog.push(entry)
  }

  if (log) {
    for (const [kind, configured] of [
      ['availableTools', available],
      ['excludedTools', excluded],
    ] as const) {
      for (const raw of configured ?? []) {
        if (!matched.has(sanitizeName(raw))) {
          log('warn', `[mcp] ${kind}: "${raw}" matches no discovered tool`)
        }
      }
    }
  }
  return { tools: result, catalog: filteredCatalog }
}
