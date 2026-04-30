import type { ToolSet } from 'ai'

export type ProviderType =
  | 'openai'
  | 'anthropic'
  | 'openai-compatible'
  | 'google'
  | 'xai'
  | 'azure'
  | 'amazon-bedrock'
  | 'google-vertex'
  | 'deepseek'
  | 'gateway'
  | 'cloudflare'

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

// Per-stage override for the planner / synthesizer. Each field is optional
// and inherits from the top-level IAgentConfig defaults when omitted, so the
// common case (one provider, one key, one model) stays a single block.
//
// Cross-provider override caveat: setting `providerType` without `apiKey`
// throws at createAgent time - inheriting a key across providers is almost
// always a configuration mistake (different vendors, different keys).
export interface IAgentStageOverride {
  providerType?: ProviderType
  baseURL?: string
  apiKey?: string
  model?: string
  // Escape hatch for provider-specific factory options that don't fit the
  // baseURL/apiKey shape: Azure `apiVersion` / `resourceName`, Bedrock
  // `region` / `accessKeyId` / `secretAccessKey`, Vertex `project` /
  // `location` / `googleAuthOptions`, Cloudflare `accountId`, and so on.
  // The map is spread into the SDK's create* call AFTER baseURL/apiKey, so
  // callers can also override those when needed. Inherits from the top-level
  // config.providerOptions when omitted.
  providerOptions?: Record<string, unknown>
}

export interface IAgentConfig {
  clientName: string
  providerType: ProviderType
  // Optional for providers with a default endpoint (openai, anthropic, google,
  // xai, deepseek, gateway, amazon-bedrock, google-vertex, cloudflare).
  // Required for `openai-compatible` (point at a self-hosted server) and
  // `azure` (point at the Azure OpenAI deployment URL).
  baseURL?: string
  apiKey: string
  model: string
  // Provider-specific extras forwarded to the SDK factory. See
  // IAgentStageOverride.providerOptions for details. Each per-stage override
  // can supply its own block; when absent, this top-level value is used.
  providerOptions?: Record<string, unknown>
  // Per-stage overrides. Use these to put planner on a small/cheap model
  // while running synthesis on a larger one, OR to mix providers entirely
  // (e.g. Gemini planner, Anthropic synthesizer). Each block is independent;
  // omit it to inherit every default from the top level.
  planner?: IAgentStageOverride
  synthesizer?: IAgentStageOverride
  // Deprecated single-string shortcuts. Equivalent to
  // `planner: { model }` / `synthesizer: { model }`. Kept for back-compat
  // with the pre-stage-override API; prefer the override blocks for new code.
  // If both are set for the same stage, the block wins.
  /** @deprecated use `planner: { model }` */
  plannerModel?: string
  /** @deprecated use `synthesizer: { model }` */
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
  // Hard cap on the number of concurrent agent.run() calls a single agent
  // instance will accept. When the cap is reached, further run() calls reject
  // synchronously with a ConcurrencyLimitError. Default: unlimited. The cap
  // is intentionally a throw rather than a queue - applications that need
  // back-pressure should run a queue on their side.
  maxConcurrentRuns?: number
  // Optional facade for durable run snapshots. The agent itself never reads
  // the data back; implementations can persist for audit, debugging, or
  // resume-after-crash workflows.
  persistence?: IPersistence
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
  // Fires once per planner step as soon as the structured-output stream has
  // emitted enough fields for the step to be coherent (description present).
  // The step may still be revised before plan.created lands - prefer this
  // event for incremental UI hints, and plan.created for the canonical plan.
  | { type: 'plan.step-added'; step: IPlanStep; index: number }
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

// Synchronous callback fired right before each plan step starts executing.
// The caller can call `abort()` to cancel JUST that step (the rest of the
// run continues - the cancelled step records as blocked, the replanner is
// invoked next). This is distinct from the run-level AbortSignal, which
// terminates the whole run.
export interface IStepStartInfo {
  step: IPlanStep
  index: number
  abort: () => void
}

export interface IAgentRunOptions {
  // Required for fresh runs; ignored when resumeFromRunId is set (the
  // snapshot's input wins so the resumed run is deterministic against the
  // original prompt).
  input: string
  history?: IConversationTurn[]
  signal?: AbortSignal
  onEvent?: EventHandler
  onStepStart?: (info: IStepStartInfo) => void
  // Resume a previously persisted run. Requires config.persistence.loadRun
  // to be implemented and the snapshot to be in a non-terminal state (i.e.
  // not 'complete'). The runner re-uses the saved runId, plan, trace, and
  // counters; the saved sandbox dir is recreated lazily but its prior
  // contents are gone unless keepSandbox was true on the original run.
  resumeFromRunId?: string
}

export interface IAgentRunResult {
  text: string
  plan: IPlan
  trace: IStepResult[]
  iterations: number
  usage: IUsage
}

// Snapshot of a run handed to IPersistence hooks. Each hook receives the
// fields most relevant at its lifecycle point; consumers should treat these
// as read-only.
//
// Resume semantics: stepIndex / iterations / revisions are the loop counters
// at the moment the snapshot was taken. On resume, the runner picks up at
// trace.length and inherits iterations/revisions so the per-run caps still
// apply across crashes.
export interface IRunSnapshot {
  runId: string
  startedAt: number
  // 'executing' is the only non-terminal status the runtime writes; the
  // others are written exactly once when the run resolves. ('planning' is
  // intentionally omitted - we never persist before the plan is in hand,
  // so there's no row in that state to query for.)
  status: 'executing' | 'complete' | 'failed' | 'cancelled'
  input: string
  history?: IConversationTurn[]
  plan?: IPlan
  trace: IStepResult[]
  usage: IUsage
  // Loop counters at snapshot time. iterations counts every executed step
  // (including those replaced by a revise), revisions counts replan revises.
  // stepIndex is the NEXT step index to execute within `plan.steps`; on
  // resume it should equal trace.length when the saved plan is still in play.
  stepIndex: number
  iterations: number
  revisions: number
  text?: string
  error?: string
  completedAt?: number
}

// Optional persistence facade. Write hooks fire at run start, after each
// step, and at run completion. Implementations decide what (if anything) to
// durably store. loadRun is consulted only when the caller asks for a resume
// via IAgentRunOptions.resumeFromRunId.
//
// Write hooks: errors are caught and logged at warn level - persistence
// failures must NEVER crash a run. Reads in loadRun, by contrast, propagate
// to the caller (a missing snapshot is a configuration / programmer error).
export interface IPersistence {
  onRunStart?: (snapshot: IRunSnapshot) => void | Promise<void>
  onStepComplete?: (snapshot: IRunSnapshot) => void | Promise<void>
  onRunComplete?: (snapshot: IRunSnapshot) => void | Promise<void>
  // Optional read hook used by agent.run({ resumeFromRunId }). Returns the
  // saved snapshot, or null when not found. Implementations that don't want
  // to support resume can simply omit this method.
  loadRun?: (runId: string) => IRunSnapshot | null | Promise<IRunSnapshot | null>
}
