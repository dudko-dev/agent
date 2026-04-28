import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js'
import { ToolListChangedNotificationSchema } from '@modelcontextprotocol/sdk/types.js'
import { dynamicTool, jsonSchema, type ToolSet } from 'ai'
import { randomUUID } from 'node:crypto'
import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { URL } from 'node:url'
import packageJson from '../package.json' with { type: 'json' }
import { getCurrentRunSandbox } from './context.ts'
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
  // start with zero tools).
  results: { name: string; connected: boolean; error?: string }[]
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

  const registerServerTools = async (name: string, client: Client): Promise<void> => {
    // Drop existing entries for this server before re-listing. We mutate in
    // place so external references to `tools` and `catalog` stay valid.
    for (const k of Object.keys(tools)) {
      if (k.startsWith(`${name}__`)) {
        delete tools[k]
      }
    }
    for (let i = catalog.length - 1; i >= 0; i--) {
      if (catalog[i].server === name) {
        catalog.splice(i, 1)
      }
    }

    const listed = await client.listTools()
    let mounted = 0
    let skipped = 0
    for (const t of listed.tools) {
      const prefixed = `${name}__${t.name}`
      if (prefixed.length > MAX_TOOL_NAME_LEN) {
        log(
          'warn',
          `[mcp] ${name}: tool "${t.name}" prefixed name (${prefixed.length} chars) exceeds the ${MAX_TOOL_NAME_LEN}-char limit enforced by major LLM providers; skipping`,
        )
        skipped++
        continue
      }
      const description = t.description ?? ''
      tools[prefixed] = dynamicTool({
        description,
        inputSchema: jsonSchema(t.inputSchema as Parameters<typeof jsonSchema>[0]),
        execute: async (args, opts) => {
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
          const result = await client.callTool(
            {
              name: t.name,
              arguments: toSend,
            },
            undefined,
            opts?.abortSignal ? { signal: opts.abortSignal } : undefined,
          )
          const flat = await flattenContent(result.content, {
            toolName: prefixed,
            // Resolved per-call so concurrent runs spill into their own
            // per-runId subdirs. undefined when called outside of a run
            // (defensive; in practice every tool call sits inside runAgentLoop).
            sandboxDir: getCurrentRunSandbox(),
          })
          if (!outputSanitizer) {
            return flat
          }
          try {
            return await outputSanitizer(prefixed, flat)
          } catch (err) {
            // Sanitizer failures must not leak details into the LLM tool
            // output: a buggy sanitizer could otherwise expose internal
            // logic or PII while attempting to scrub it. Log and return a
            // safe placeholder; the run continues with degraded data.
            log(
              'warn',
              `[mcp] ${prefixed}: outputSanitizer threw - ${(err as Error).message}; output replaced with placeholder`,
            )
            return '[output redacted: sanitizer failed]'
          }
        },
      })
      catalog.push({ name: prefixed, description, server: name })
      mounted++
    }
    if (skipped > 0) {
      log('info', `[mcp] ${name}: ${mounted} tools mounted, ${skipped} skipped (length cap)`)
    } else {
      log('info', `[mcp] ${name}: ${mounted} tools mounted`)
    }
  }

  for (const [name, cfg] of Object.entries(servers)) {
    try {
      let transport: Transport
      if (isStdioConfig(cfg)) {
        // stdio: spawn the configured executable; the SDK pipes JSON-RPC
        // over the child's stdin/stdout. We do NOT pass a default env here -
        // when env is omitted the SDK calls getDefaultEnvironment() which
        // already filters to a safe inheritance subset (PATH, HOME, etc.).
        transport = new StdioClientTransport({
          command: cfg.command,
          args: cfg.args,
          env: cfg.env,
          cwd: cfg.cwd,
        })
      } else if (isHttpConfig(cfg)) {
        if (cfg.headers && cfg.getHeaders) {
          throw new Error(`MCP server "${name}": specify either headers or getHeaders, not both`)
        }
        const headers = cfg.getHeaders ? await cfg.getHeaders() : cfg.headers
        transport = new StreamableHTTPClientTransport(new URL(cfg.url), {
          requestInit: headers ? { headers } : undefined,
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

      const client = new Client({ name: clientName, version: CLIENT_VERSION })
      await client.connect(transport)
      clients.set(name, client)

      // Subscribe BEFORE the first list call: a server that mutates its tool
      // set during init would otherwise lose the notification in the small
      // window between connect() and listTools().
      if (onToolsChanged) {
        client.setNotificationHandler(ToolListChangedNotificationSchema, () => {
          onToolsChanged(name)
        })
      }

      await registerServerTools(name, client)
      results.push({ name, connected: true })
    } catch (err) {
      const message = (err as Error).message
      log('error', `[mcp] ${name}: failed to connect - ${message}`)
      results.push({ name, connected: false, error: message })
    }
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
): Promise<ISpilledRef> => {
  await mkdir(sandboxDir, { recursive: true })
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
): { tools: ToolSet; catalog: IConnectedMcp['catalog'] } => {
  const allow = available?.length ? new Set(available) : null
  const deny = excluded?.length ? new Set(excluded) : null

  const result: ToolSet = {}
  const filteredCatalog: IConnectedMcp['catalog'] = []

  for (const entry of catalog) {
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
  return { tools: result, catalog: filteredCatalog }
}
