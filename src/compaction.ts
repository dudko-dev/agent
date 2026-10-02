import { generateText, type LanguageModel, type Tool, type ToolSet } from 'ai'
import type { ICompactionConfig, IConversationTurn, IStepResult, IUsage } from './types.ts'
import { clipText, normalizeUsage, withTimeout } from './utils.ts'

export const DEFAULT_CONTEXT_WINDOW_TOKENS = 128_000
export const DEFAULT_MAX_TOOL_OUTPUT_CHARS = 20_000

export interface IResolvedCompaction {
  auto: boolean
  contextWindowTokens: number
  thresholdTokens: number
  keepRecentTurns: number
  keepRecentSteps: number
  summaryMaxTokens: number
  maxToolOutputChars: number
  clearToolResultsAfterTokens: number
  keepToolResults: number
}

const nonNeg = (v: number | undefined, fallback: number): number =>
  typeof v === 'number' && Number.isFinite(v) && v >= 0 ? Math.floor(v) : fallback

export const resolveCompaction = (cfg: ICompactionConfig | undefined): IResolvedCompaction => {
  const contextWindowTokens = nonNeg(cfg?.contextWindowTokens, 0) || DEFAULT_CONTEXT_WINDOW_TOKENS
  return {
    auto: cfg?.auto !== false,
    contextWindowTokens,
    thresholdTokens: nonNeg(cfg?.thresholdTokens, 0) || Math.floor(contextWindowTokens / 2),
    keepRecentTurns: nonNeg(cfg?.keepRecentTurns, 4),
    keepRecentSteps: nonNeg(cfg?.keepRecentSteps, 3),
    summaryMaxTokens: nonNeg(cfg?.summaryMaxTokens, 0) || 1024,
    maxToolOutputChars: nonNeg(cfg?.maxToolOutputChars, DEFAULT_MAX_TOOL_OUTPUT_CHARS),
    clearToolResultsAfterTokens: nonNeg(
      cfg?.clearToolResultsAfterTokens,
      Math.floor(contextWindowTokens / 4),
    ),
    keepToolResults: nonNeg(cfg?.keepToolResults, 3),
  }
}

// Cheap, provider-agnostic token estimate: ~4 chars per token.
export const estimateTokens = (text: string): number => Math.ceil(text.length / 4)

export const SUMMARY_PREFIX = '[Summary of earlier conversation]'

export const isSummaryTurn = (t: IConversationTurn): boolean =>
  t.role === 'assistant' && t.content.startsWith(SUMMARY_PREFIX)

export const renderTurns = (turns: IConversationTurn[]): string =>
  turns.map((t) => `${t.role}: ${t.content}`).join('\n')

const HISTORY_SUMMARY_SYSTEM = `You compress conversation history for an AI agent.

Summarize the conversation below into a compact, factual record that lets the agent continue the conversation without the original turns. Keep: what the user asked for and decided, facts and results the assistant reported (names, identifiers, numbers, URLs, file paths, dates), open questions and commitments. Drop greetings, filler and repetition. Write plain text in the conversation's language, no preamble.`

const TRACE_SUMMARY_SYSTEM = `You compress the execution trace of an AI agent.

Summarize the executed steps below into a compact, factual record the agent can rely on for the remaining steps. Keep every concrete result: identifiers, names, numbers, URLs, file paths, errors and what failed, and conclusions. Drop narration. Write plain text, no preamble.`

export interface ICompactHistoryOptions {
  // Compact only when the estimate exceeds this (default 64_000).
  thresholdTokens?: number
  // Turns kept verbatim (default 4).
  keepRecentTurns?: number
  // Output cap of the summary call (default 1024).
  summaryMaxTokens?: number
  // Compact regardless of the threshold.
  force?: boolean
  signal?: AbortSignal
  timeoutMs?: number
  // Usage of the summary call (it is NOT added to any run by itself).
  onUsage?: (usage: IUsage) => void
}

export interface ICompactHistoryResult {
  history: IConversationTurn[]
  summary?: string
  beforeTokens: number
  afterTokens: number
  compacted: boolean
  usage?: IUsage
}

/**
 * Summarise all but the last `keepRecentTurns` turns into ONE assistant turn
 * prefixed "[Summary of earlier conversation]" (an earlier summary turn is
 * folded into the new one). Never throws: on failure, or below the
 * threshold without `force`, the input comes back unchanged. The input array
 * is never mutated.
 */
export const compactHistory = async (
  turns: IConversationTurn[],
  model: LanguageModel,
  opts: ICompactHistoryOptions = {},
): Promise<ICompactHistoryResult> => {
  const beforeTokens = estimateTokens(renderTurns(turns))
  const unchanged: ICompactHistoryResult = {
    history: turns,
    beforeTokens,
    afterTokens: beforeTokens,
    compacted: false,
  }
  const threshold = opts.thresholdTokens ?? DEFAULT_CONTEXT_WINDOW_TOKENS / 2
  if (!opts.force && beforeTokens <= threshold) {
    return unchanged
  }
  const keep = Math.max(0, opts.keepRecentTurns ?? 4)
  const cut = turns.length - keep
  if (cut <= 0) {
    return unchanged
  }
  const older = turns.slice(0, cut)
  if (older.length === 1 && isSummaryTurn(older[0])) {
    return unchanged
  }
  try {
    const r = await generateText({
      model,
      instructions: HISTORY_SUMMARY_SYSTEM,
      prompt: `Conversation to summarize:\n${renderTurns(older)}`,
      maxOutputTokens: opts.summaryMaxTokens ?? 1024,
      abortSignal: withTimeout(opts.signal, opts.timeoutMs ?? 0),
      maxRetries: 0,
    })
    const usage = normalizeUsage(r.usage)
    opts.onUsage?.(usage)
    const summary = r.text.trim()
    if (!summary) {
      return { ...unchanged, usage }
    }
    const history: IConversationTurn[] = [
      { role: 'assistant', content: `${SUMMARY_PREFIX}\n${summary}` },
      ...turns.slice(cut),
    ]
    return {
      history,
      summary,
      beforeTokens,
      afterTokens: estimateTokens(renderTurns(history)),
      compacted: true,
      usage,
    }
  } catch {
    return unchanged
  }
}

export interface ISummarizeTraceOptions {
  summaryMaxTokens?: number
  signal?: AbortSignal
  timeoutMs?: number
  // Renders the steps (the prompt module's renderer, injected to avoid a
  // circular import).
  render: (steps: IStepResult[], offset: number) => string
  // Index of steps[0] in the full trace.
  offset: number
}

/**
 * Fold `steps` (and an earlier running summary) into a new running summary.
 * Never throws: undefined on failure.
 */
export const summarizeTrace = async (
  steps: IStepResult[],
  previousSummary: string | undefined,
  model: LanguageModel,
  opts: ISummarizeTraceOptions,
): Promise<{ summary: string; usage: IUsage } | undefined> => {
  try {
    const r = await generateText({
      model,
      instructions: TRACE_SUMMARY_SYSTEM,
      prompt: [
        previousSummary ? `Summary of the steps before these:\n${previousSummary}\n` : '',
        `Steps to summarize:\n${opts.render(steps, opts.offset)}`,
      ]
        .filter(Boolean)
        .join('\n'),
      maxOutputTokens: opts.summaryMaxTokens ?? 1024,
      abortSignal: withTimeout(opts.signal, opts.timeoutMs ?? 0),
      maxRetries: 0,
    })
    const summary = r.text.trim()
    return summary ? { summary, usage: normalizeUsage(r.usage) } : undefined
  } catch {
    return undefined
  }
}

// ── model-visible tool output cap ────────────────────────────────────────

type ToolModelOutput = Awaited<ReturnType<NonNullable<Tool['toModelOutput']>>>

/**
 * Clip what the MODEL sees of one tool result: text values, the JSON
 * serialisation of json values (which then becomes text), and text parts of
 * content values. Error / denied outputs pass through. Pure.
 */
export const truncateToolModelOutput = (
  output: ToolModelOutput,
  maxChars: number,
): ToolModelOutput => {
  if (!(maxChars > 0)) {
    return output
  }
  switch (output.type) {
    case 'text':
      return output.value.length > maxChars
        ? { ...output, value: clipText(output.value, maxChars) }
        : output
    case 'json': {
      let s: string | undefined
      try {
        s = JSON.stringify(output.value)
      } catch {
        return output
      }
      return s !== undefined && s.length > maxChars
        ? {
            type: 'text',
            value: clipText(s, maxChars),
            ...(output.providerOptions ? { providerOptions: output.providerOptions } : {}),
          }
        : output
    }
    case 'content':
      return {
        ...output,
        value: output.value.map((part) =>
          part.type === 'text' && part.text.length > maxChars
            ? { ...part, text: clipText(part.text, maxChars) }
            : part,
        ),
      }
    default:
      return output
  }
}

// What the AI SDK sends when a tool has no toModelOutput.
const defaultModelOutput = (output: unknown): ToolModelOutput => {
  if (typeof output === 'string') {
    return { type: 'text', value: output }
  }
  if (output === undefined) {
    return { type: 'json', value: null }
  }
  try {
    const s = JSON.stringify(output)
    return { type: 'json', value: s === undefined ? null : JSON.parse(s) }
  } catch {
    return { type: 'text', value: String(output) }
  }
}

/**
 * Wrap a tool so the model sees at most `maxChars` of each result (with a
 * "… [truncated N chars]" marker). An existing toModelOutput runs first and
 * its value is clipped. The raw output (trace, events) is untouched.
 */
export const withToolOutputLimit = <T extends Tool>(tool: T, maxChars: number): T => {
  if (!(maxChars > 0)) {
    return tool
  }
  const own = tool.toModelOutput
  const toModelOutput: Tool['toModelOutput'] = async (opts) =>
    truncateToolModelOutput(own ? await own(opts) : defaultModelOutput(opts.output), maxChars)
  return { ...tool, toModelOutput }
}

export const withToolSetOutputLimit = (tools: ToolSet, maxChars: number): ToolSet => {
  const out: ToolSet = {}
  for (const [name, tool] of Object.entries(tools)) {
    out[name] = withToolOutputLimit(tool, maxChars)
  }
  return out
}
