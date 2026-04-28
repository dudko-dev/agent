import type { ToolSet } from 'ai'

export type ProviderType = 'openai' | 'anthropic' | 'openai-compatible' | 'google'

export type LogLevel = 'none' | 'error' | 'warn' | 'info' | 'debug'

// 'all'           - executor receives the full filtered ToolSet on every step.
//                   Best for catalogs <= ~50 tools.
// 'plan-narrowed' - executor receives only tools listed in step.suggestedTools.
//                   Planner is required to populate suggestedTools when a step
//                   needs tools; empty means "reasoning-only step".
export type ToolSelectionStrategy = 'all' | 'plan-narrowed'

// Remote MCP server reached over StreamableHTTP/SSE.
export interface IMcpHttpServerConfig {
  url: string
  headers?: Record<string, string>
  // Called at connect time (and on reconnect) to provide fresh request headers.
  // Use this when tokens rotate; combine with `agent.reconnect()` to refresh
  // an expired Bearer.
  getHeaders?: () => Promise<Record<string, string>> | Record<string, string>
}

// Local MCP server spawned as a child process. The transport speaks JSON-RPC
// over the process's stdin/stdout. `stderr` of the child is inherited by
// default so server logs are visible in the agent's terminal.
export interface IMcpStdioServerConfig {
  command: string
  args?: string[]
  env?: Record<string, string>
  cwd?: string
}

// Discriminated union: callers pick HTTP or stdio per server. Existing
// callers passing { url, headers? } typecheck unchanged as IMcpHttpServerConfig.
export type IMcpServerConfig = IMcpHttpServerConfig | IMcpStdioServerConfig

export interface IAgentConfig {
  clientName: string
  providerType: ProviderType
  // Optional for providers with a default endpoint (openai, anthropic, google).
  // Required for openai-compatible (where you point at a self-hosted server).
  baseURL?: string
  apiKey: string
  model: string
  plannerModel?: string
  synthesizerModel?: string
  mcpServers: Record<string, IMcpServerConfig>
  // Native AI-SDK tools registered alongside MCP-discovered tools. Names
  // must not collide with any MCP-prefixed tool ("server__tool"); createAgent
  // throws on conflict. Native tools bypass outputSanitizer/inputSanitizer
  // since the caller already controls their implementation.
  tools?: ToolSet
  availableTools?: string[]
  excludedTools?: string[]
  // Cap on executed steps across the run (every step counts, including those
  // executed after a "revise"). Guards against runaway loops.
  maxIterations: number
  // Cap on LLM steps inside a single executor call (multi-step tool calling).
  maxStepsPerTask: number
  // Cap on the number of "revise" decisions the replanner can make per run.
  maxRevisions?: number
  // Soft cap on cumulative tokens; checked between steps and triggers an
  // early jump to synthesis when crossed.
  maxTotalTokens?: number
  llmTimeoutMs?: number
  llmMaxRetries?: number
  toolSelectionStrategy?: ToolSelectionStrategy
  // Sanitize an input the LLM passed to a tool BEFORE the call is dispatched
  // and BEFORE the step.tool-call event is emitted. Use to redact secrets the
  // model may have copied from prior context (auth tokens, PII) so they don't
  // reach external services or event consumers / log sinks.
  //
  // CONTRACT: must be IDEMPOTENT. The sanitizer is applied twice per call -
  // once in the executor before event emission, once in the MCP wrapper
  // before dispatch - so calling f(f(x)) must equal f(x). Typical
  // implementations (regex redaction, key stripping, value masking) satisfy
  // this naturally. Throwing replaces the input with a safe placeholder string
  // and the call proceeds, so the model sees a deterministic failure rather
  // than a hang.
  inputSanitizer?: (toolName: string, input: unknown) => unknown | Promise<unknown>
  outputSanitizer?: (toolName: string, output: unknown) => unknown | Promise<unknown>
  logLevel: LogLevel
  systemPrompt?: string
  // Root directory for per-run sandbox subdirs. Each agent.run() call gets
  // its own <sandboxRoot>/<runId>/ folder, created lazily the first time a
  // tool writes a binary blob. Defaults to <os.tmpdir()>/agent-sandbox.
  // Tools (native or via MCP) can reach the directory via getCurrentRunSandbox().
  sandboxRoot?: string
  // When true, the per-run sandbox directory is NOT removed after the run
  // completes. Useful for debugging or post-run inspection. Default false.
  keepSandbox?: boolean
  // When true, createAgent throws if every configured MCP server failed to
  // connect (i.e. the agent would start with zero tools). Defaults to false:
  // the agent starts and the failure is surfaced via 'log' events at error
  // level.
  failOnNoTools?: boolean
}

export interface IConversationTurn {
  role: 'user' | 'assistant'
  content: string
}

export interface IUsage {
  inputTokens: number
  outputTokens: number
  totalTokens: number
}

export interface IPlanStep {
  id: string
  description: string
  expectedOutcome: string
  suggestedTools?: string[]
  // Set by the planner pipeline (not the LLM) when the step originally listed
  // suggestedTools but every name was unknown. Signals to the executor that
  // the step does want tools, even though suggestedTools ended up empty -
  // narrowed mode then falls back to the full toolset rather than running the
  // step with zero tools.
  requiresTools?: boolean
}

export interface IPlan {
  thought: string
  steps: IPlanStep[]
}

export interface IStepResult {
  step: IPlanStep
  summary: string
  toolCalls: { name: string; input: unknown; output: unknown; ok: boolean }[]
  durationMs: number
  // True when the executor signalled it could not complete the step (via the
  // [BLOCKER] sentinel in its reply). The replanner is invoked on this signal.
  blocked: boolean
}

export type ReplanCause = 'last-step' | 'clean-step' | 'llm-decision'

type AgentEventBody =
  | { type: 'plan.thought-delta'; delta: string }
  | { type: 'plan.created'; plan: IPlan }
  | { type: 'plan.revised'; plan: IPlan; reason: string }
  | { type: 'step.start'; step: IPlanStep; index: number }
  | { type: 'step.text-delta'; step: IPlanStep; delta: string }
  | { type: 'step.tool-call'; step: IPlanStep; name: string; input: unknown }
  | { type: 'step.tool-result'; step: IPlanStep; name: string; output: unknown; ok: boolean }
  | { type: 'step.complete'; step: IPlanStep; result: IStepResult }
  | {
      type: 'replan.decision'
      mode: 'continue' | 'revise' | 'finish'
      reason: string
      cause: ReplanCause
    }
  | { type: 'final.text-delta'; delta: string }
  | { type: 'final'; text: string }
  | { type: 'log'; level: LogLevel; message: string }
  | { type: 'usage'; phase: 'plan' | 'execute' | 'replan' | 'synthesize'; usage: IUsage }
  | {
      type: 'retry'
      phase: 'plan' | 'execute' | 'replan' | 'synthesize'
      attempt: number
      error: string
    }
  | { type: 'budget.exceeded'; tokens: number; cap: number }
  | { type: 'revisions.exceeded'; cap: number }
  | { type: 'error'; error: Error; phase: 'plan' | 'execute' | 'replan' | 'synthesize' | 'init' }

// runId is auto-populated at emit time from AsyncLocalStorage. Consumers that
// multiplex events across concurrent runs on the same agent should filter by it.
export type AgentEvent = AgentEventBody & { runId?: string }

export type EventHandler = (event: AgentEvent) => void

export interface IAgentRunOptions {
  input: string
  history?: IConversationTurn[]
  signal?: AbortSignal
  onEvent?: EventHandler
}

export interface IAgentRunResult {
  text: string
  plan: IPlan
  trace: IStepResult[]
  iterations: number
  usage: IUsage
}
