import { tool, type ToolSet } from 'ai'
import { z } from 'zod'
import { markReadOnly } from './approval.ts'
import { runContext } from './context.ts'
import type { EffectiveToolStrategy } from './internal.ts'
import type { IAgentConfig, IToolCatalogEntry } from './types.ts'

export const FIND_TOOLS_TOOL = 'find_tools'
export const DEFAULT_TOOL_SEARCH_THRESHOLD = 40
// Discovered tools carried into later steps (most recent first).
export const MAX_CARRIED_DISCOVERED_TOOLS = 16
const DEFAULT_SEARCH_LIMIT = 8
const MAX_SEARCH_LIMIT = 20

// 'auto' -> 'all' up to toolSearchThreshold tools, 'search' above.
export const resolveToolStrategy = (
  config: Pick<IAgentConfig, 'toolSelectionStrategy' | 'toolSearchThreshold'>,
  catalogSize: number,
): EffectiveToolStrategy => {
  const s = config.toolSelectionStrategy ?? 'auto'
  if (s === 'auto') {
    const threshold = config.toolSearchThreshold ?? DEFAULT_TOOL_SEARCH_THRESHOLD
    return catalogSize > threshold ? 'search' : 'all'
  }
  return s
}

// Lowercased word tokens; splits on non-alphanumerics AND camelCase
// ("listOpenIssues" -> list, open, issues; "github__get_PR" -> github, get, pr).
export const tokenizeForSearch = (text: string): string[] =>
  text
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean)

const hit = (tokens: string[], term: string): boolean =>
  tokens.some((t) => t === term || (term.length >= 3 && t.startsWith(term)))

export interface ISearchToolsOptions {
  // Only tools of this MCP server ('<native>' for config.tools).
  server?: string
  // Default 8, clamped to 1..20.
  limit?: number
}

/**
 * Rank catalogue entries for a free-text query. Pure.
 * score = Σ over query terms of 3·nameHit + 2·serverHit + 1·descriptionHit,
 * with prefix matching for terms of 3+ chars. Zero scores are dropped; ties
 * keep catalogue order.
 */
export const searchTools = <T extends IToolCatalogEntry>(
  catalog: T[],
  query: string,
  opts: ISearchToolsOptions = {},
): T[] => {
  const terms = [...new Set(tokenizeForSearch(query))]
  if (terms.length === 0) {
    return []
  }
  const raw = Math.floor(opts.limit ?? DEFAULT_SEARCH_LIMIT)
  const limit = Math.min(MAX_SEARCH_LIMIT, Math.max(1, Number.isFinite(raw) ? raw : 8))
  const server = opts.server?.trim().toLowerCase()
  const scored: { entry: T; score: number; index: number }[] = []
  catalog.forEach((entry, index) => {
    if (server && (entry.server ?? '').toLowerCase() !== server) {
      return
    }
    const nameTokens = tokenizeForSearch(entry.name)
    const serverTokens = tokenizeForSearch(entry.server ?? '')
    const descTokens = tokenizeForSearch(entry.description ?? '')
    let score = 0
    for (const term of terms) {
      score +=
        (hit(nameTokens, term) ? 3 : 0) +
        (hit(serverTokens, term) ? 2 : 0) +
        (hit(descTokens, term) ? 1 : 0)
    }
    if (score > 0) {
      scored.push({ entry, score, index })
    }
  })
  scored.sort((a, b) => b.score - a.score || a.index - b.index)
  return scored.slice(0, limit).map((s) => s.entry)
}

export const SEARCH_CATALOG_BUDGET_CHARS = 12_000
const SEARCH_DESC_CHARS = 60

/**
 * The planner's / replanner's view of a large catalogue: grouped by server,
 * one short line per tool, within a char budget, then a pointer to
 * find_tools for the rest.
 */
export const renderSearchCatalog = (
  catalog: IToolCatalogEntry[],
  budget = SEARCH_CATALOG_BUDGET_CHARS,
): string => {
  if (catalog.length === 0) {
    return '(no tools available)'
  }
  const groups = new Map<string, IToolCatalogEntry[]>()
  for (const entry of catalog) {
    const key = entry.server ?? '<native>'
    const list = groups.get(key) ?? []
    list.push(entry)
    groups.set(key, list)
  }
  const lines: string[] = []
  let used = 0
  let shown = 0
  outer: for (const [server, entries] of groups) {
    const header = `[${server}]`
    if (used + header.length + 1 > budget) {
      break
    }
    lines.push(header)
    used += header.length + 1
    for (const t of entries) {
      const desc = (t.description || '').replace(/\s+/g, ' ').trim().slice(0, SEARCH_DESC_CHARS)
      const line = `- ${t.name}: ${desc}`
      if (used + line.length + 1 > budget) {
        break outer
      }
      lines.push(line)
      used += line.length + 1
      shown++
    }
  }
  const rest = catalog.length - shown
  if (rest > 0) {
    lines.push(`… ${rest} more tools — the executor can find them with ${FIND_TOOLS_TOOL}`)
  }
  return lines.join('\n')
}

/**
 * The find_tools built-in: searches the live catalogue and ACTIVATES the
 * matches for the rest of the executor call and the run.
 */
export const createFindToolsTool = (getCatalog: () => IToolCatalogEntry[]): ToolSet => ({
  [FIND_TOOLS_TOOL]: markReadOnly(
    tool({
      description:
        'Search the full tool catalogue by keywords and ACTIVATE the matching tools: they become callable from your next step on. Use it whenever the tools you need are not loaded yet.',
      inputSchema: z.object({
        query: z
          .string()
          .describe('Keywords describing the capability you need, e.g. "list github issues"'),
        server: z.string().optional().describe('Restrict the search to one MCP server'),
        limit: z.number().optional().describe('Max results (default 8, max 20)'),
      }),
      execute: async ({ query, server, limit }) => {
        const found = searchTools(getCatalog(), query, { server, limit })
        const names = found.map((t) => t.name)
        const store = runContext.getStore()
        const state = store?.state
        if (state) {
          for (const name of names) {
            const at = state.discovered.indexOf(name)
            if (at >= 0) {
              state.discovered.splice(at, 1)
            }
            state.discovered.push(name)
            state.stepActive?.add(name)
          }
        }
        if (store?.emit && store.currentStep) {
          store.emit({ type: 'tools.discovered', step: store.currentStep, query, names })
        }
        return {
          tools: found.map((t) => ({
            name: t.name,
            description: t.description,
            server: t.server ?? '<native>',
            readOnly: t.readOnly === true,
          })),
        }
      },
    }),
  ),
})
