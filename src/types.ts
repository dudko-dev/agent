import type { OAuthClientProvider } from '@modelcontextprotocol/sdk/client/auth.js'
import type { FetchLike } from '@modelcontextprotocol/sdk/shared/transport.js'
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
//                   Best for catalogs <= ~40 tools.
// 'plan-narrowed' - executor receives only tools listed in step.suggestedTools.
//                   Planner is required to populate suggestedTools when a step
//                   needs tools; empty means "reasoning-only step".
// 'search'        - executor starts each step with the built-in tools, the
//                   step's suggestedTools and the tools discovered earlier in
//                   the run, plus `find_tools`, which searches the whole
//                   catalogue and activates matches for the rest of the run.
//                   Built for catalogues of hundreds of tools.
// 'auto' (default) - 'all' while the filtered catalogue has at most
//                   `toolSearchThreshold` (default 40) tools, 'search' above.
export type ToolSelectionStrategy = 'all' | 'plan-narrowed' | 'search' | 'auto'

// The four LLM stages of the loop. The replanner shares the planner's model
// but has its own thinking / per-call budget knobs.
export type AgentStage = 'planner' | 'executor' | 'replanner' | 'synthesizer'

// Portable reasoning effort, mapped by the AI SDK onto each provider's own
// knob. 'none' explicitly disables thinking; 'provider-default' sends the
// provider's default level.
export type ThinkingLevel =
  'provider-default' | 'none' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh'

export interface IThinkingConfig {
  // Default 'medium'.
  level?: ThinkingLevel
  // Exact token budget. Becomes provider-specific options for providers that
  // take a budget rather than an effort level (Anthropic, Google).
  budgetTokens?: number
  // Ask the provider to stream its thoughts (step.reasoning-delta /
  // final.reasoning-delta) where it supports that. Default true.
  includeThoughts?: boolean
}

// false / undefined -> send nothing (provider default); true -> 'medium';
// a bare level -> { level }.
export type ThinkingSetting = boolean | ThinkingLevel | IThinkingConfig

// Cumulative per-run token caps. Soft caps: checked between steps and at
// every executor LLM step boundary; once crossed the run stops executing
// steps and goes straight to synthesis (which still runs, capped by
// perCall.synthesizer).
export interface ITokenLimits {
  maxInputTokens?: number
  // Includes reasoning tokens.
  maxOutputTokens?: number
  maxReasoningTokens?: number
  // input + output. Falls back to the legacy top-level `maxTotalTokens`.
  maxTotalTokens?: number
  // maxOutputTokens for every single LLM call of a stage.
  perCall?: {
    planner?: number
    executor?: number
    replanner?: number
    synthesizer?: number
    compaction?: number
  }
}

export type TokenLimitKind = 'input' | 'output' | 'reasoning' | 'total'

// What a `budget.exceeded` event reports. For 'tool-calls', `tokens` carries
// the number of tool calls made.
export type BudgetKind = TokenLimitKind | 'tool-calls'

export interface ILimitBreach {
  kind: TokenLimitKind
  tokens: number
  cap: number
}

// Context compaction. Everything has a default; pass `{ auto: false }` to
// keep only the manual `agent.compact()` and the tool-output cap.
export interface ICompactionConfig {
  // Compact history (at run start) and trace (before each executor /
  // replanner / synthesizer call) when their estimate crosses the threshold.
  // Default true.
  auto?: boolean
  // Model context window, in tokens. Default 128_000.
  contextWindowTokens?: number
  // Compact when the estimated context exceeds this. Default: 50% of the
  // window.
  thresholdTokens?: number
  // History turns kept verbatim (default 4).
  keepRecentTurns?: number
  // Trace steps kept verbatim (default 3).
  keepRecentSteps?: number
  // Output cap of a summary call (default 1024).
  summaryMaxTokens?: number
  // Per tool result the MODEL sees (default 20_000; 0 = unlimited). The raw
  // output still lands in the trace and the events.
  maxToolOutputChars?: number
  // Inside one step's tool loop: once its context passes this many tokens,
  // the oldest tool results become one-line stubs (context editing). Default:
  // a quarter of the window; 0 = never.
  clearToolResultsAfterTokens?: number
  // Most recent tool results kept verbatim when clearing (default 3).
  keepToolResults?: number
}

// An agentskills.io-style skill: a name + a one-line description shown in an
// index, and instructions the agent loads only when the skill applies.
export interface ISkill {
  // [a-z0-9-]{1,64}
  name: string
  // When to use it (shown in the index).
  description: string
  // Full instructions (markdown body).
  content: string
  // Bundled text resources, skill-relative POSIX paths.
  files?: { path: string; content: string }[]
}

// How tool calls are consented:
//   'autopilot'  - every call runs (default);
//   'ask-writes' - read-only tools run, anything else asks;
//   'ask-all'    - every call asks;
//   'read-only'  - read-only tools run, anything else is denied.
export type ToolApprovalMode = 'autopilot' | 'ask-writes' | 'ask-all' | 'read-only'

export type ToolPermission = 'allow' | 'ask' | 'deny'

export interface IToolApprovalRequest {
  // Unique per request.
  id: string
  toolName: string
  // The tool input AFTER inputSanitizer.
  input: unknown
  // The tool is known to be read-only (MCP readOnlyHint or markReadOnly).
  readOnly: boolean
  step?: IPlanStep
  runId?: string
}

// `remember: true` on an approval allows the tool for the rest of this agent
// instance's life without asking again.
export type ToolApprovalDecision =
  boolean | { approved: boolean; reason?: string; remember?: boolean }

export interface IToolApprovalConfig {
  // Default 'autopilot'. Switch at runtime with agent.setToolApprovalMode().
  mode?: ToolApprovalMode
  // Exact tool names or '*' globs, e.g. { 'github__delete_*': 'deny' }.
  // The most specific match wins (exact > longest glob) and beats the mode.
  rules?: Record<string, ToolPermission>
  // Called for every 'ask'. Without it an 'ask' is a denial.
  onRequest?: (req: IToolApprovalRequest) => ToolApprovalDecision | Promise<ToolApprovalDecision>
  // No decision within this many ms -> deny. Default: wait forever.
  timeoutMs?: number
}

// true (default) / false, or options: Anthropic cache TTL and the OpenAI
// prompt cache key (default `${clientName}:${stage}`).
export type PromptCachingSetting = boolean | { ttl?: '5m' | '1h'; key?: string }

// One entry of the tool catalogue (agent.listTools()).
export interface IToolCatalogEntry {
  name: string
  description: string
  // MCP server name, or '<native>' for config.tools.
  server?: string
  // Known to be read-only (MCP annotations.readOnlyHint, or markReadOnly()).
  readOnly?: boolean
}

// Remote MCP server reached over StreamableHTTP. (Legacy HTTP+SSE servers -
// the 2024-11-05 transport with a separate /sse endpoint - are NOT supported;
// point this at a StreamableHTTP endpoint.)
export interface IMcpHttpServerConfig {
  url: string
  headers?: Record<string, string>
  // Called at connect time (and on reconnect) to provide fresh request headers.
  // Use this when tokens rotate; combine with `agent.reconnect()` to refresh
  // an expired Bearer. Note that it is resolved ONCE per connect - for tokens
  // that expire mid-run, use `authProvider` instead.
  getHeaders?: () => Promise<Record<string, string>> | Record<string, string>
  // Full OAuth 2.1: the SDK discovers the authorization server (RFC 9728),
  // registers dynamically when the provider supports it (RFC 7591), attaches
  // the access token, and REFRESHES it on a 401 before retrying the request.
  // See `createNodeOAuthProvider` for a file-backed implementation, or supply
  // any OAuthClientProvider of your own.
  authProvider?: OAuthClientProvider
  // Custom fetch for every HTTP request the transport and the OAuth flow make:
  // corporate proxies, mTLS agents, instrumentation.
  fetch?: FetchLike
  // A server that does not finish connect + tools/list within this many ms
  // is reported as failed and closed; the others still mount. Overrides the
  // top-level mcpConnectTimeoutMs. Default 30_000; 0 disables.
  connectTimeoutMs?: number
}

// Local MCP server spawned as a child process. The transport speaks JSON-RPC
// over the process's stdin/stdout. `stderr` of the child is inherited by
// default so server logs are visible in the agent's terminal.
export interface IMcpStdioServerConfig {
  command: string
  args?: string[]
  env?: Record<string, string>
  cwd?: string
  // See IMcpHttpServerConfig.connectTimeoutMs.
  connectTimeoutMs?: number
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
  // What makes the LLM replanner run after a step (it never runs after the
  // last planned step):
  //   'failure' (default) - the step was blocked, or a tool call failed and
  //     stayed failed (a later successful call to the same tool within the
  //     step counts as self-corrected);
  //   'always' - after every step, e.g. when the host surfaces problems to
  //     the replanner through systemPrompt/domain context (costs one extra
  //     LLM call per step);
  //   predicate - decides per step result; may be async and close over host
  //     state. A predicate that throws, rejects, or outlives llmTimeoutMs /
  //     the run signal falls back to the 'failure' rule, so a buggy or hung
  //     predicate can never stall the run.
  replanAfter?: ReplanTrigger
  // Soft cap on cumulative tokens; checked between steps and triggers an
  // early jump to synthesis when crossed. Legacy shortcut for
  // `limits.maxTotalTokens` (which wins when both are set).
  maxTotalTokens?: number
  // Cumulative per-run token caps + per-call output caps. See ITokenLimits.
  limits?: ITokenLimits
  // Cap on tool calls per run (across steps). Once reached, further calls
  // fail with "tool-call budget exhausted" and the run goes to synthesis.
  maxToolCalls?: number
  // Hard cap on the number of steps in a plan (initial and revised).
  // Default 8.
  maxPlanSteps?: number
  // Thinking / reasoning for every stage. Per-stage entries in stageThinking
  // win. Compaction calls never think.
  thinking?: ThinkingSetting
  stageThinking?: Partial<Record<AgentStage, ThinkingSetting>>
  // History / trace compaction and the model-visible tool-output cap.
  compaction?: ICompactionConfig
  // Skills the planner can pick and the executor can load on demand.
  skills?: ISkill[]
  // Tool-call consent. Default: autopilot (every call runs).
  toolApproval?: IToolApprovalConfig
  // 'auto' switches to 'search' above this many tools. Default 40.
  toolSearchThreshold?: number
  // Default connect + tools/list timeout for every MCP server (each server
  // can override it). Default 30_000; 0 disables.
  mcpConnectTimeoutMs?: number
  // Provider prompt caching. Default true: run-stable system prompts, an
  // Anthropic cache breakpoint on them, and an OpenAI prompt cache key.
  promptCaching?: PromptCachingSetting
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
  // Optional in the type for back-compat; the agent always fills them.
  // Part of outputTokens.
  reasoningTokens?: number
  // Input tokens served from the provider's prompt cache (part of inputTokens).
  cachedInputTokens?: number
  // Input tokens written to the provider's prompt cache.
  cacheWriteTokens?: number
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
  // Names of configured skills the planner picked for this request. Their
  // instructions are injected into the executor / replanner / synthesizer.
  skills?: string[]
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

// When the LLM replanner is consulted after a step; see IAgentConfig.replanAfter.
export type ReplanTrigger =
  'failure' | 'always' | ((result: IStepResult) => boolean | Promise<boolean>)

export type ReplanCause = 'last-step' | 'clean-step' | 'llm-decision'

// Phase of a `usage` event. 'compact' is a compaction summary call;
// 'subagent' is usage a subagent tool spent (it counts against this run's
// limits like any other).
export type UsagePhase = 'plan' | 'execute' | 'replan' | 'synthesize' | 'compact' | 'subagent'

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
  // The model's thoughts, when thinking is on and the provider streams them.
  | { type: 'step.reasoning-delta'; step: IPlanStep; delta: string }
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
  | { type: 'final.reasoning-delta'; delta: string }
  | { type: 'final'; text: string }
  | { type: 'log'; level: LogLevel; message: string }
  | { type: 'usage'; phase: UsagePhase; usage: IUsage }
  | {
      type: 'retry'
      phase: 'plan' | 'execute' | 'replan' | 'synthesize'
      attempt: number
      error: string
    }
  // A run-level cap was crossed; the run stops executing steps and
  // synthesizes. For kind 'tool-calls', `tokens` is the tool-call count.
  | { type: 'budget.exceeded'; kind: BudgetKind; tokens: number; cap: number }
  | {
      type: 'context.compacted'
      // tool-results = stale results inside a step's tool loop.
      scope: 'history' | 'trace' | 'tool-results'
      beforeTokens: number
      afterTokens: number
    }
  | { type: 'skill.activated'; name: string; by: 'plan' | 'tool' }
  // find_tools found and activated these tools (search strategy).
  | { type: 'tools.discovered'; step: IPlanStep; query: string; names: string[] }
  // Only when the agent actually asks (onRequest is called).
  | {
      type: 'tool.approval-requested'
      id: string
      name: string
      input: unknown
      readOnly: boolean
      step?: IPlanStep
    }
  // automatic: true for rule / mode / timeout denials nobody decided on.
  // Automatic ALLOWs emit nothing, to keep the stream quiet.
  | {
      type: 'tool.approval-resolved'
      id: string
      name: string
      approved: boolean
      reason?: string
      automatic: boolean
    }
  | { type: 'subagent.start'; id: string; name: string; task: string }
  // A child event, forwarded verbatim (long strings clipped).
  | { type: 'subagent.event'; id: string; name: string; event: AgentEvent }
  | { type: 'subagent.complete'; id: string; name: string; text: string; usage: IUsage }
  | { type: 'subagent.error'; id: string; name: string; error: string }
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
  // Set when the run compacted the history it was given (the caller's array
  // is never mutated). Persist it in place of the old history.
  compactedHistory?: IConversationTurn[]
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
  // Running summary of trace[0, traceSummaryUpTo) once trace compaction has
  // kicked in; prompts render it in place of those steps.
  traceSummary?: string
  traceSummaryUpTo?: number
  // Skills activated so far (by the plan or by load_skill).
  activeSkills?: string[]
  // Tool calls made so far (counts against maxToolCalls on resume).
  toolCallCount?: number
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
