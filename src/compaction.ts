import { asSchema, generateText, type LanguageModel, type Tool, type ToolSet } from 'ai'
import type { ICompactionConfig, IConversationTurn, IStepResult, IUsage } from './types.ts'
import { clipText, normalizeUsage, withTimeout } from './utils.ts'

export const DEFAULT_CONTEXT_WINDOW_TOKENS = 128_000
export const DEFAULT_MAX_TOOL_OUTPUT_CHARS = 20_000

// Compaction starts at this share of the window unless configured. The estimate leans high (see
// estimateTokens), so on a Claude model this is roughly 70-75% really used - the rest is room for
// the answer and for what one step adds before the next check.
export const DEFAULT_COMPACTION_THRESHOLD_RATIO = 0.85

export interface IResolvedCompaction {
  auto: boolean
  contextWindowTokens: number
  thresholdTokens: number
  thresholdRatio: number
  keepRecentTurns: number
  keepRecentSteps: number
  summaryMaxTokens: number
  maxToolOutputChars: number
  clearToolResultsAfterTokens: number
  keepToolResults: number
}

const nonNeg = (v: number | undefined, fallback: number): number =>
  typeof v === 'number' && Number.isFinite(v) && v >= 0 ? Math.floor(v) : fallback

const ratioOf = (r: number | undefined): number =>
  typeof r === 'number' && r > 0 && r <= 1 ? r : DEFAULT_COMPACTION_THRESHOLD_RATIO

export const resolveCompaction = (cfg: ICompactionConfig | undefined): IResolvedCompaction => {
  const contextWindowTokens = nonNeg(cfg?.contextWindowTokens, 0) || DEFAULT_CONTEXT_WINDOW_TOKENS
  const thresholdRatio = ratioOf(cfg?.thresholdRatio)
  return {
    auto: cfg?.auto !== false,
    contextWindowTokens,
    thresholdTokens:
      nonNeg(cfg?.thresholdTokens, 0) || Math.floor(contextWindowTokens * thresholdRatio),
    thresholdRatio,
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

// Chinese / Japanese / Korean characters and the halves of a surrogate pair (emoji): about a
// token each. Other non-ASCII text (Cyrillic, Greek, accented Latin...) about two characters.
const isWide = (c: number): boolean =>
  (c >= 0x3040 && c <= 0x9fff) || (c >= 0xac00 && c <= 0xd7af) || (c >= 0xd800 && c <= 0xdfff)

// Cheap, provider-agnostic token estimate, by kind of character - because text is not one thing:
// letters run ~2.5 to a token (prose is kinder, code, markdown and JSON are not), digits and
// punctuation about one each (JSON, tables, ids), a space a quarter, a newline one, other scripts
// (Russian...) two characters, CJK and emoji one. Calibrated against Claude's tokenizer, the most
// token-hungry in use, over prose, markdown, code, JSON, a table, Russian and a mix: it comes out
// 1.1-1.4x the real count and never below it (a flat "4 characters a token" was 0.4-0.7x for
// everything but Russian). It errs high ON PURPOSE: it decides when to compact, and compacting a
// little early is cheap while overflowing the window is a failed run. A tokenizer that packs
// tighter (OpenAI, Gemini) makes it higher still - then raise thresholdRatio.
export const estimateTokens = (text: string): number => {
  let letters = 0
  let digits = 0
  let spaces = 0
  let newlines = 0
  let punct = 0
  let other = 0
  let wide = 0
  for (let i = 0; i < text.length; i += 1) {
    const c = text.charCodeAt(i)
    if (c < 128) {
      if ((c >= 97 && c <= 122) || (c >= 65 && c <= 90)) {
        letters += 1
      } else if (c >= 48 && c <= 57) {
        digits += 1
      } else if (c === 32 || c === 9) {
        spaces += 1
      } else if (c === 10) {
        newlines += 1
      } else {
        punct += 1
      }
    } else if (isWide(c)) {
      wide += 1
    } else {
      other += 1
    }
  }
  // In thousandths of a token, so the arithmetic is exact: 1.1 x (letters / 2.5 + digits +
  // punctuation x 1.1 + spaces / 4 + newlines + other / 2 + wide).
  return Math.ceil(
    (440 * letters +
      1100 * digits +
      1210 * punct +
      275 * spaces +
      1100 * newlines +
      550 * other +
      1100 * wide) /
      1000,
  )
}

// The NEWEST part of `text` that fits `maxTokens` (estimated). Cut at a line break when there is
// one near the cut, so a summariser never starts mid-sentence if it can help it.
export const tailWithinTokens = (text: string, maxTokens: number): string => {
  if (!(maxTokens > 0) || estimateTokens(text) <= maxTokens) {
    return text
  }
  let cut = text.slice(-Math.max(1, Math.floor(maxTokens * 4)))
  while (cut.length > 1 && estimateTokens(cut) > maxTokens) {
    cut = cut.slice(Math.ceil(cut.length * 0.1))
  }
  const nl = cut.indexOf('\n')
  return nl >= 0 && nl < cut.length / 4 ? cut.slice(nl + 1) : cut
}

// What every call carries whatever the transcript: stage instructions, the goal, the plan, the state.
export const BASE_PROMPT_TOKENS = 1500
// Under tool search the model is sent only the built-ins and the tools found so far.
export const SEARCH_TOOLS_ALLOWANCE = 3000

const toolTokenCache = new WeakMap<object, number>()

// Estimated tokens of the tool definitions a model is sent (name, description, JSON schema of the
// input). Cached per tool object: a tool set is rebuilt rarely and its schemas never change.
export const toolDefinitionTokens = async (tools: ToolSet): Promise<number> => {
  const sizes = await Promise.all(
    Object.entries(tools).map(async ([name, t]) => {
      const cached = toolTokenCache.get(t)
      if (cached !== undefined) {
        return cached
      }
      let parameters: unknown
      try {
        parameters = await asSchema(t.inputSchema as never).jsonSchema
      } catch {
        parameters = undefined
      }
      const size = estimateTokens(
        JSON.stringify({ name, description: t.description ?? '', parameters }),
      )
      toolTokenCache.set(t, size)
      return size
    }),
  )
  return sizes.reduce((a, b) => a + b, 0)
}

// The tokens of a call's prompt that do not come from the transcript or the step log - the stage
// instructions, the tool definitions, the skills - so that compaction can judge how full the
// window really is (history and trace alone say nothing about a 15k-token tool catalogue).
export const promptOverheadTokens = (p: {
  systemPrompt?: string
  toolTokens: number
  // Tool search: only a few definitions are sent at a time.
  searching: boolean
  // The rendered skills index and the active skills' instructions.
  skillsText: string
}): number =>
  BASE_PROMPT_TOKENS +
  estimateTokens(p.systemPrompt ?? '') +
  (p.searching ? Math.min(p.toolTokens, SEARCH_TOOLS_ALLOWANCE) : p.toolTokens) +
  estimateTokens(p.skillsText)

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
  // Compact only when the estimate - plus overheadTokens - exceeds this (default 80% of the
  // default 128_000 window).
  thresholdTokens?: number
  // What the call carries besides this history (system prompt, tool definitions, skills): it
  // shares the window, so it counts against the threshold.
  overheadTokens?: number
  // Turns kept verbatim (default 4).
  keepRecentTurns?: number
  // Output cap of the summary call (default 1024).
  summaryMaxTokens?: number
  // The most the summariser is shown, in estimated tokens (the newest part is kept). Default:
  // everything older than the kept turns.
  maxInputTokens?: number
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
  const threshold =
    opts.thresholdTokens ??
    Math.floor(DEFAULT_CONTEXT_WINDOW_TOKENS * DEFAULT_COMPACTION_THRESHOLD_RATIO)
  if (!opts.force && beforeTokens + (opts.overheadTokens ?? 0) <= threshold) {
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
      prompt: `Conversation to summarize:\n${
        opts.maxInputTokens
          ? tailWithinTokens(renderTurns(older), opts.maxInputTokens)
          : renderTurns(older)
      }`,
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
  // The most the summariser is shown, in estimated tokens (the newest part is kept).
  maxInputTokens?: number
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
        `Steps to summarize:\n${
          opts.maxInputTokens
            ? tailWithinTokens(opts.render(steps, opts.offset), opts.maxInputTokens)
            : opts.render(steps, opts.offset)
        }`,
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
