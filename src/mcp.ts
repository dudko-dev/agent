import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { ToolListChangedNotificationSchema } from '@modelcontextprotocol/sdk/types.js'
import { dynamicTool, jsonSchema, type ToolSet } from 'ai'
import { URL } from 'node:url'
import packageJson from '../package.json' with { type: 'json' }
import type { IMcpServerConfig } from './types.ts'

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
          const result = await client.callTool(
            {
              name: t.name,
              arguments: (args ?? {}) as Record<string, unknown>,
            },
            undefined,
            opts?.abortSignal ? { signal: opts.abortSignal } : undefined,
          )
          const flat = flattenContent(result.content)
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
    if (cfg.headers && cfg.getHeaders) {
      throw new Error(`MCP server "${name}": specify either headers or getHeaders, not both`)
    }
    try {
      const headers = cfg.getHeaders ? await cfg.getHeaders() : cfg.headers
      const transport = new StreamableHTTPClientTransport(new URL(cfg.url), {
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

export const flattenContent = (content: unknown): unknown => {
  if (!Array.isArray(content)) {
    return content
  }
  const parts = content as Array<Record<string, unknown>>
  // Symmetric: if every part is text, return their concatenation as a single
  // string; otherwise return the array of parts (text parts unwrapped to plain
  // strings). Avoids the prior footgun where the same tool could yield a
  // string for one call and an array for the next based purely on the number
  // of content parts. We do NOT auto-parse JSON-looking text to keep type
  // stable ("42" stays string, never becomes number).
  const allText =
    parts.length > 0 && parts.every((p) => p?.type === 'text' && typeof p.text === 'string')
  if (allText) {
    return parts.map((p) => p.text as string).join('\n')
  }
  return parts.map((p) => {
    if (p?.type === 'text' && typeof p.text === 'string') {
      return p.text
    }
    return p
  })
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
