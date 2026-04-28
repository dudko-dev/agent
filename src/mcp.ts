import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { dynamicTool, jsonSchema, type ToolSet } from 'ai'
import { URL } from 'node:url'
import type { IMcpServerConfig } from './types.ts'

export interface IConnectedMcp {
  tools: ToolSet
  catalog: { name: string; description: string; server: string }[]
  close: () => Promise<void>
  // Per-server connect outcome so the caller can decide whether to fail hard
  // (e.g. when every configured server failed and the agent would otherwise
  // start with zero tools).
  results: { name: string; connected: boolean; error?: string }[]
}

export const connectMcpServers = async (
  servers: Record<string, IMcpServerConfig>,
  log: (level: 'info' | 'warn' | 'error', message: string) => void,
  clientName: string,
  outputSanitizer?: (toolName: string, output: unknown) => unknown | Promise<unknown>,
): Promise<IConnectedMcp> => {
  const clients: Client[] = []
  const tools: ToolSet = {}
  const catalog: IConnectedMcp['catalog'] = []
  const results: IConnectedMcp['results'] = []

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

      const client = new Client({ name: clientName, version: '0.0.0' })
      await client.connect(transport)
      clients.push(client)

      const listed = await client.listTools()
      let mounted = 0
      for (const t of listed.tools) {
        const prefixed = `${name}__${t.name}`
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
      log('info', `[mcp] ${name}: connected, ${mounted} tools`)
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
      await Promise.allSettled(clients.map((c) => c.close()))
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
