# @dudko.dev/agent

This lightweight, opinionated planning agent automates complex workflows by orchestrating tools through the [Model Context Protocol (MCP)](https://modelcontextprotocol.io/). Built on the [Vercel AI SDK](https://sdk.vercel.ai/) and TypeScript, it offers a truly platform-agnostic solution that integrates into any environment. Its modular architecture allows you to mix and match LLM providers for planning, execution, and synthesis—optimizing for both performance and cost while turning sophisticated AI orchestration into a streamlined, production-ready process. ESM and CJS builds, a REPL CLI, OpenTelemetry instrumentation, and built-in support for persistence and resume make it a versatile choice for developers looking to harness the full potential of LLM-driven agents.

[![npm](https://img.shields.io/npm/v/@dudko.dev/agent.svg)](https://www.npmjs.com/package/@dudko.dev/agent)
[![npm](https://img.shields.io/npm/dy/@dudko.dev/agent.svg)](https://www.npmjs.com/package/@dudko.dev/agent)
[![NpmLicense](https://img.shields.io/npm/l/@dudko.dev/agent.svg)](https://www.npmjs.com/package/@dudko.dev/agent)
![GitHub last commit](https://img.shields.io/github/last-commit/dudko-dev/agent.svg)
![GitHub release](https://img.shields.io/github/release/dudko-dev/agent.svg)

> Node/server sibling of the **browser** package
> [`@dudko.dev/agent-web`](https://www.npmjs.com/package/@dudko.dev/agent-web) —
> the same plan → execute → replan → synthesize loop running fully in-browser
> (BYOK cloud providers or local WebGPU/WebLLM models, encrypted IndexedDB
> token vault, HTTP MCP).

The agent runs a plan → execute → replan → synthesize loop:

1. **Plan** — the planner LLM produces a structured plan (a thought + ordered steps with optional suggested tools).
2. **Execute** — the executor LLM runs each step, calling MCP tools through the Vercel AI SDK.
3. **Replan** — after each step the replanner decides whether to continue, revise the plan, or finish.
4. **Synthesize** — once finished, the synthesizer LLM writes the final answer for the user.

Multi-provider out of the box: OpenAI, Anthropic, Google (Gemini), xAI (Grok), Azure OpenAI, Amazon Bedrock, Google Vertex, DeepSeek, Vercel AI Gateway, Cloudflare Workers AI, and any OpenAI-compatible endpoint. Streaming events, per-run cancellation via `AbortSignal`, retry/timeout, and concurrent runs on a single agent instance.

On top of the loop:

- **[Thinking](#thinking-reasoning)** per stage, with the model's thoughts streamed as events.
- **[Token limits](#token-limits-and-step-caps)** — input / output / reasoning / total caps per run, enforced at every LLM step boundary, plus per-call output caps and a tool-call cap.
- **[Compaction](#compaction)** of long histories and traces (automatic and manual), and a cap on what the model sees of each tool result.
- **[Skills](#skills)** — agentskills.io-style `SKILL.md` instructions the planner picks and the executor loads on demand.
- **[Tool approval](#tool-approval-and-autopilot)** — autopilot, ask-for-writes, ask-for-all or read-only, with glob rules and a runtime toggle.
- **[Large MCP catalogs](#large-mcp-catalogs)** — tool search for hundreds of tools, `tools/list` pagination, connect timeouts.
- **[Prompt caching](#prompt-caching)** — run-stable system prompts, Anthropic cache breakpoints, OpenAI cache keys.
- **[Subagents](#subagents-worker_threads)** — a whole agent exposed as one tool, isolated in a `worker_thread`.
- **[Autonomy](#autonomy)** — the agent looks things up and decides on its own instead of asking.

## Install

```bash
npm install @dudko.dev/agent
```

Requires Node.js **22.6+**.

Provider SDKs are **optional peer dependencies** — install only the one(s) you actually use:

```bash
# pick one (or more) per project
npm install @ai-sdk/openai
npm install @ai-sdk/anthropic
npm install @ai-sdk/google
npm install @ai-sdk/openai-compatible
npm install @ai-sdk/xai
npm install @ai-sdk/azure
npm install @ai-sdk/amazon-bedrock
npm install @ai-sdk/google-vertex
npm install @ai-sdk/deepseek
npm install workers-ai-provider          # cloudflare
# gateway: no extra install — ships inside `ai`
```

Setting `providerType` to a value whose SDK isn't installed throws a clear `"Provider package "@ai-sdk/X" is not installed"` error at `createAgent` time.

## Quick start

```ts
import { createAgent } from '@dudko.dev/agent'

const agent = await createAgent({
  clientName: 'my-app',
  providerType: 'openai',
  apiKey: process.env.OPENAI_API_KEY!,
  model: 'gpt-4.1-mini',
  mcpServers: {
    docs: { url: 'https://mcp.example.com/mcp' },
  },
  maxIterations: 6,
  maxStepsPerTask: 8,
  logLevel: 'info',
})

const result = await agent.run({
  input: 'Find the latest pricing page and summarize the tiers.',
})

console.log(result.text)
console.log(`tokens: ${result.usage.totalTokens}`)

await agent.close()
```

### Streaming events

Pass an event handler as the second argument to `createAgent`, or per run via `onEvent`. Events include plan deltas, step starts and tool calls, replanner decisions, retries, budget breaches, the streamed final answer, and errors. See [`AgentEvent`](./src/types.ts) for the full union; the newer ones:

| Event | When |
| --- | --- |
| `step.reasoning-delta` / `final.reasoning-delta` | The executor's / synthesizer's thoughts, when [thinking](#thinking-reasoning) is on and the provider streams them. |
| `budget.exceeded` | A run cap was crossed; `kind: 'input' \| 'output' \| 'reasoning' \| 'total' \| 'tool-calls'`, `tokens`, `cap`. |
| `context.compacted` | History or trace was compacted (`scope`, `beforeTokens`, `afterTokens`). |
| `skill.activated` | A skill became active (`by: 'plan' \| 'tool'`). |
| `tools.discovered` | `find_tools` activated tools (`query`, `names`). |
| `tool.approval-requested` / `tool.approval-resolved` | The approval gate asked / decided (`automatic` for rule, mode and timeout denials). |
| `subagent.start` / `subagent.event` / `subagent.complete` / `subagent.error` | A subagent tool call's lifecycle and its forwarded child events. |
| `usage` | Per LLM call; `phase` is `'plan' \| 'execute' \| 'replan' \| 'synthesize' \| 'compact' \| 'subagent'`. |

```ts
const agent = await createAgent(config, (event) => {
  if (event.type === 'final.text-delta') process.stdout.write(event.delta)
})
```

### Cancellation

```ts
const ac = new AbortController()
setTimeout(() => ac.abort(), 30_000)

await agent.run({ input: '...', signal: ac.signal })
```

The run-level signal terminates everything. To cancel a single step (e.g. a long tool call) without aborting the whole run, use `onStepStart` — the cancelled step records as `blocked: true` and the replanner runs next:

```ts
await agent.run({
  input: '...',
  onStepStart: ({ step, abort }) => {
    if (step.suggestedTools?.includes('expensive_tool')) {
      abort()
    }
  },
})
```

### Resume after crash

Wire a persistence adapter that implements `loadRun(runId)`, then resume with the run id:

```ts
import { makeSqlitePersistence } from './examples/persistence-sqlite.ts'

const persistence = makeSqlitePersistence('./runs.db')
const agent = await createAgent({ ..., persistence, keepSandbox: true })

try {
  await agent.run({ input: '...' })
} catch (err) {
  // process crashed mid-run; the snapshot has the latest checkpoint.
}

// Later, in a new process:
await agent.run({ input: '', resumeFromRunId: '<saved-run-id>' })
```

Caveats:

- **Idempotency.** Resume re-enters the loop at the saved checkpoint (the iteration boundary after the last successful step). A crash mid-step means the in-flight step's tool calls are lost; on resume, the runner re-executes that step from scratch. If your tools have side effects (writes, payments, emails), the same call may fire twice. Design tools to be idempotent or guard against replay.
- **Sandbox.** The per-run sandbox directory is auto-cleaned on completion. To resume, set `keepSandbox: true` so files written by earlier steps survive the crash. Without it, the trace's file references will point to a directory that no longer exists.
- **Plan changes.** The saved `currentPlan` (post any revise) is what gets used on resume — the planner is not re-invoked.
- **Caps inherit.** `iterations`, `revisions`, usage and the tool-call count (`toolCallCount`) carry over, so per-run caps still apply across the boundary; so do the active skills (`activeSkills`) and the trace summary (`traceSummary` / `traceSummaryUpTo`).
- **Terminal status.** Resuming a run with `status: 'complete'` throws — re-read the saved `text` directly instead.
- **Event semantics.** On resume the runner re-emits a `plan.created` event so consumers attaching mid-resume see the canonical plan; consumers that store every event will observe `plan.created` twice for the same `runId`. `onRunStart` is **not** re-fired (the original run already emitted it) — code that counts run starts must use `runId` for de-duplication. `onStepComplete` only fires for steps the resumed run actually executes; pre-resume steps are already in the loaded `trace`.
- **Inputs are locked to the snapshot.** Both `options.input` and `options.history` passed to `agent.run({ resumeFromRunId })` are **silently ignored** in favor of the values stored at the original run start. This keeps the resumed prompt deterministic against the saved trace; pass an empty input (`input: ''`) to make the override explicit.
- **runId hygiene.** Persisted `runId`s end up in filesystem paths (`<sandboxRoot>/<runId>/`) and are validated against `^[a-zA-Z0-9_-]{1,128}$`. A persistence adapter that returns a snapshot whose `runId` differs from the requested one, or that contains path-unsafe characters, is rejected.

### OpenTelemetry

The agent emits OTel spans for `agent.run`, `agent.plan`, `agent.execute_step`, `agent.replan`, and `agent.synthesize` via the `@opentelemetry/api` package. With no SDK installed, the calls are no-ops; install your favorite OTel exporter (jaeger, otlp, console) and you get traces and parent-child relationships out of the box. Span attributes are documented in [`src/tracing.ts`](./src/tracing.ts).

### Conversation history

Pass prior turns as `history` on each run; the agent treats them as context but does not mutate the array.

```ts
const history = [
  { role: 'user', content: 'Who maintains the docs server?' },
  { role: 'assistant', content: 'The platform team owns it.' },
]
await agent.run({ input: 'Got a contact?', history })
```

### Reconnecting MCP

Use `getHeaders` on a server config to inject fresh credentials at connect time, then call `agent.reconnect()` after a token rotation. Reconnect refuses while runs are in flight.

`getHeaders` is resolved **once per connect**, so it cannot save a token that expires mid-run — for that, use OAuth.

### MCP over OAuth 2.1

Point `authProvider` at an `OAuthClientProvider` and the SDK discovers the authorization server (RFC 9728), registers this client dynamically when it has no `client_id` yet (RFC 7591), runs PKCE, and — the part a header cannot do — **refreshes the access token on a 401 and retries the request**. `createNodeOAuthProvider` persists tokens and the registration in a `0600` JSON file, so a restarted process picks up where it left off.

```ts
import { createAgent, createNodeOAuthProvider, finishMcpOAuth } from '@dudko.dev/agent'

const auth = createNodeOAuthProvider({
  serverUrl: 'https://mcp.example.com/mcp',
  redirectUrl: 'http://127.0.0.1:8765/callback', // whatever you listen on
  onAuthorizationUrl: (url) => console.error('Authorize here:', url.href),
})

const agent = await createAgent({ /* … */ mcpServers: { docs: { url: auth.serverUrl, authProvider: auth } } })

// First run only: the server answers 401, the connect result carries
// needsAuthorization, and the operator visits the URL above. Feed the code back:
await finishMcpOAuth(auth, { code, state })
await agent.reconnect()
```

Nothing is printed or opened on your behalf; `onAuthorizationUrl` and the loopback listener are yours to wire. `agent.listTools()` stays empty until the flow completes — a server that needs authorization reports `needsAuthorization: true` in its connect result rather than a generic failure. `MCP_SERVERS` (the CLI's env config) is JSON, so it can only express `headers`; OAuth is a library-level feature.

## Thinking (reasoning)

Turn on the model's reasoning for every stage with `thinking`, and override it per stage with `stageThinking` (a stage entry — even `false` — wins over the top-level value):

```ts
const agent = await createAgent({
  ...config,
  thinking: 'medium', // boolean | level | { level?, budgetTokens?, includeThoughts? }
  stageThinking: {
    planner: 'high', // plans and revisions deserve the most
    executor: { level: 'low' },
    synthesizer: false, // provider default
  },
})
```

| Setting | Sent to the provider |
| --- | --- |
| `false` / unset | nothing — the provider's default |
| `true` | `{ level: 'medium' }` |
| `'provider-default' \| 'minimal' \| 'low' \| 'medium' \| 'high' \| 'xhigh'` | the AI SDK's portable `reasoning` option, mapped onto each provider's own knob |
| `'none'` | `reasoning: 'none'` — explicitly off |
| `{ budgetTokens }` | an exact budget: Anthropic `thinking.budgetTokens`, Google `thinkingConfig.thinkingBudget` |
| `includeThoughts` (default `true`) | asks Google (`includeThoughts`) and OpenAI (`reasoningSummary: 'auto'`) to return their thoughts |

`resolveThinking(setting)` is exported (pure) if you want to see exactly what a setting becomes. Provider-specific options always win over the portable level inside the SDK.

The executor streams thoughts as `step.reasoning-delta` and the synthesizer as `final.reasoning-delta`. The planner and replanner use structured output, which has no reasoning stream. Compaction calls never think. Usage reports `reasoningTokens` (part of `outputTokens`).

> Some models refuse thinking together with forced structured output. If the planner fails with thinking on, disable it there: `stageThinking: { planner: false, replanner: false }`.

## Token limits and step caps

```ts
const agent = await createAgent({
  ...config,
  limits: {
    maxInputTokens: 400_000, // cumulative per run
    maxOutputTokens: 40_000, // includes reasoning
    maxReasoningTokens: 20_000,
    maxTotalTokens: 500_000, // input + output (falls back to the legacy top-level maxTotalTokens)
    perCall: { planner: 2_000, executor: 4_000, replanner: 1_000, synthesizer: 3_000, compaction: 1_024 },
  },
  maxToolCalls: 40, // tool calls per run, across steps
  maxPlanSteps: 6, // hard cap on plan steps (default 8)
})
```

The run caps are **soft**: they are checked between steps *and* inside an executor step, as an extra `stopWhen` condition that adds the usage of the step's LLM calls to the run so far — so a runaway tool loop stops at its next LLM step instead of at the end of the step. When a cap is crossed the agent emits `budget.exceeded` (`kind: 'input' | 'output' | 'reasoning' | 'total' | 'tool-calls'`), stops executing steps and goes straight to synthesis, which still runs (capped by `perCall.synthesizer`). `checkLimits(usage, limits)` is the pure check, exported.

`maxToolCalls`: once reached, further tool calls in the run fail with `tool-call budget exhausted` (the model sees that as the tool result) and the run moves to synthesis with `budget.exceeded` of kind `'tool-calls'`. Built-in tools (`find_tools`, `load_skill`, `read_skill_file`) do not count.

The other step caps are unchanged: `maxIterations` (executed steps per run), `maxStepsPerTask` (LLM steps inside one executor call) and `maxRevisions` (replanner revisions per run).

`IUsage` reports `reasoningTokens`, `cachedInputTokens` (served from the provider's prompt cache) and `cacheWriteTokens` alongside the totals; `normalizeUsage` / `addUsage` are exported.

## Compaction

Long conversations and long runs are compacted automatically; everything is on by default and tuned with `compaction`:

```ts
compaction: {
  auto: true, // default
  contextWindowTokens: 128_000, // default
  thresholdTokens: 64_000, // default: 50% of the window
  keepRecentTurns: 4, // history turns kept verbatim
  keepRecentSteps: 3, // trace steps kept verbatim
  summaryMaxTokens: 1024,
  maxToolOutputChars: 20_000, // per tool result the MODEL sees; 0 = unlimited
  clearToolResultsAfterTokens: 32_000, // default: 25% of the window; 0 = never
  keepToolResults: 3, // newest tool results kept verbatim when clearing
}
```

- **History, at run start.** When the estimated history (`estimateTokens` = chars / 4) exceeds the threshold, all but the last `keepRecentTurns` turns become ONE assistant turn starting with `[Summary of earlier conversation]`. The run works on the compacted copy; your array is never mutated, and the result carries it as `result.compactedHistory` so you can store it instead.
- **Trace, before each executor / replanner / synthesizer call.** Over the threshold, every step but the last `keepRecentSteps` is folded into a running summary; prompts show `Summary of earlier steps: …` followed by the recent steps verbatim. The trace itself stays intact in the result, the events and persistence; the summary is saved in the snapshot (`traceSummary`, `traceSummaryUpTo`) so a resumed run keeps it.
- **Tool results.** Every tool (MCP, native, built-in) gets a `toModelOutput` that clips what the model sees to `maxToolOutputChars` with a `… [truncated N chars]` marker. A tool's own `toModelOutput` runs first. The raw output still lands in the trace and in `step.tool-result`.
- **Stale tool results inside a step** (context editing, like Anthropic's `clear_tool_uses` and Claude Code's micro-compaction). Once a step's tool loop grows past `clearToolResultsAfterTokens`, the oldest results are replaced with a one-line stub (`[<tool> result cleared to save context — call the tool again if you still need it]`), keeping the newest `keepToolResults`. The calls stay, so the model knows what it did. Clearing is sticky (the cached prefix doesn't flip back) and keyed by position, so servers that repeat tool-call ids are fine. `createToolResultClearer` is exported.

Each compaction emits `context.compacted` (`scope: 'history' | 'trace' | 'tool-results'`, `beforeTokens`, `afterTokens`); the summary call's usage is reported as `usage` with `phase: 'compact'` and counts toward the run. The synthesizer model writes the summaries.

Manual: `agent.compact({ history, force?, signal? })` returns `{ history, summary?, beforeTokens, afterTokens, compacted }`; the CLI's `/compact` does exactly that for the REPL history. `compactHistory(turns, model, opts)` is exported for use without an agent. Compaction never throws — on any failure the input comes back unchanged.

## Skills

Skills are packaged instructions in the [agentskills.io](https://agentskills.io) format: a folder per skill with a `SKILL.md` (YAML frontmatter with `name` and `description`, then the instructions) and any bundled text files.

```ts
import { createAgent, loadSkillsFromDir, parseSkillMarkdown, defineSkill } from '@dudko.dev/agent'

const skills = await loadSkillsFromDir('./skills') // every ./skills/<skill>/SKILL.md
const agent = await createAgent({ ...config, skills })
agent.listSkills() // [{ name, description }]
```

Progressive disclosure keeps them cheap:

1. The planner and executor system prompts carry only an index: `- name: description`.
2. The planner's plan has an optional `skills` field naming the skills that apply (unknown names are dropped with a warning). Their instructions are injected into the executor, replanner and synthesizer system prompts for the rest of the run (24k chars in total, clipped beyond that).
3. The executor gets two read-only built-in tools: `load_skill({ name })` returns `{ name, content, files }` and activates the skill for later steps; `read_skill_file({ name, path })` returns a bundled file. Both always run without approval.

Every activation emits `skill.activated` (`by: 'plan' | 'tool'`). A host or MCP tool named `load_skill` / `read_skill_file` is a configuration error. `parseSkillMarkdown(markdown, files?)` and `defineSkill(skill)` validate skills you build yourself (names match `[a-z0-9-]{1,64}`). `loadSkillsFromDir` bundles text files (`.md .txt .json .yaml .yml .csv .ts .js .py .sh .html .css .xml .toml`, up to 256 KB each).

## Tool approval and autopilot

By default the agent runs every tool call (**autopilot**). `toolApproval` puts the host in charge of consent:

```ts
const agent = await createAgent({
  ...config,
  toolApproval: {
    mode: 'ask-writes', // 'autopilot' | 'ask-writes' | 'ask-all' | 'read-only'
    rules: { 'github__delete_*': 'deny', github__get_me: 'allow' },
    onRequest: async ({ toolName, input, readOnly, step, runId }) => {
      const ok = await askTheUser(toolName, input)
      return { approved: ok, remember: ok } // or just true / false
    },
    timeoutMs: 60_000, // no answer -> deny
  },
})

agent.setToolApprovalMode('autopilot') // the toggle; applies to the next call, in-flight runs included
agent.getToolApprovalMode()
```

Each call is decided in this order: (1) a tool approved earlier with `remember: true` runs; (2) the most specific matching rule — exact name over the longest `*` glob — says `allow`, `ask` or `deny`; (3) the mode: `autopilot` allows, `read-only` allows read-only tools and denies the rest, `ask-writes` allows read-only tools and asks for the rest, `ask-all` asks. Built-in tools are always allowed. An `ask` without `onRequest` is a denial.

A tool is read-only when its MCP descriptor says `annotations.readOnlyHint: true`, or when a native tool is marked with `markReadOnly(tool)` (`isReadOnlyTool(tool)` checks). The request shows the input after `inputSanitizer`.

A denied call throws `ToolDeniedError` inside the tool, so the step records `ok: false` and the model reads *"Tool call denied by the user… Do not retry it; continue without it, or report what is blocked."* — the replanner sees it as any failed call. Events: `tool.approval-requested` (only when actually asking) and `tool.approval-resolved` (`automatic: true` for rule / mode / timeout denials; automatic allows emit nothing). The gate runs inside every tool's `execute` — MCP, native and subagent tools alike.

## Large MCP catalogs

**Tool search.** `toolSelectionStrategy` now defaults to `'auto'`: the executor gets every tool (`'all'`, exactly as before) while the filtered catalogue has at most `toolSearchThreshold` (default 40) tools, and switches to `'search'` above that. In `'search'` mode each step starts with the built-in tools, the step's `suggestedTools` and the tools discovered earlier in the run (the 16 most recent), plus `find_tools({ query, server?, limit? })`. It ranks the whole catalogue and **activates** the matches: they become callable from the model's next LLM step and stay active for the rest of the run (`tools.discovered` event). The planner sees an abridged catalogue grouped by server and treats `suggestedTools` as hints. The ranking is the exported pure `searchTools(catalog, query, { server?, limit? })` — terms matched in the name score 3, in the server 2, in the description 1, prefix-matched for terms of 3+ chars. `'all'` and `'plan-narrowed'` behave as before.

**Loading.** `tools/list` follows `nextCursor` (up to 100 pages), on connect and on `tools/list_changed` refreshes. Each server must connect and list within `connectTimeoutMs` (per server; default from the top-level `mcpConnectTimeoutMs`, 30 s; `0` disables) or it is reported failed (`connect timed out after Xms`) and closed while the others mount. `agent.listTools()` entries carry `server` and `readOnly`.

## Prompt caching

`promptCaching` is on by default. Every stage keeps its **system** prompt run-stable — role instructions, domain context (`systemPrompt`), the skills index, the tool catalogue where the stage shows one, and the active skills — and puts everything that changes (history, request, plan, trace) in the user message. That alone lets OpenAI and Gemini implicit caches hit. On top of it the system prompt is sent as a system message with an Anthropic ephemeral cache breakpoint, and each call carries an OpenAI `promptCacheKey` (`${clientName}:${stage}`). Unknown provider keys are ignored by other providers.

```ts
promptCaching: { ttl: '1h', key: 'my-app' } // or false to send plain system strings
```

Inside a step's tool loop a second Anthropic breakpoint **rolls to the newest message** every round, so each round reads all earlier rounds from the cache and writes only the new tail (`withRollingBreakpoint`; earlier message breakpoints are removed, so a request carries at most two — Anthropic allows four). Tools are sent and catalogued **sorted by name**, so the tool list that heads every cached prefix is identical however the MCP servers connected.

Usage reports `cachedInputTokens` / `cacheWriteTokens`, so the effect is measurable.

### Token efficiency, in one place

The practices coding agents (Claude Code, the Claude and GitHub Copilot extensions) use to keep long sessions cheap, and the knob for each:

| Practice | How | Knob |
| --- | --- | --- |
| Stable, cacheable prefix | run-stable system prompts, sorted tools, dynamic content last | `promptCaching` |
| Cache the growing loop | rolling Anthropic breakpoint; OpenAI `promptCacheKey` per stage | `promptCaching: { ttl }` |
| Don't send every tool | compact catalogue + `find_tools` above the threshold (deferred tools) | `toolSelectionStrategy`, `toolSearchThreshold` |
| Load instructions on demand | skills: name + description in the prompt, body on activation | `skills` |
| Cap tool output | per result, as the model sees it | `compaction.maxToolOutputChars` |
| Clear stale tool results | oldest results in a long loop become stubs | `compaction.clearToolResultsAfterTokens` |
| Auto-compact | history and trace summarised past a threshold; `agent.compact()` | `compaction` |
| Isolate side quests | subagents (worker_threads) with their own context; only the answer returns | `createSubagentTool` |
| Pass results, not transcripts | later steps and the answer get step summaries + clipped findings | — |
| Bound everything | tokens per run / kind, per-call output caps, tool-call and plan-step caps | `limits`, `maxToolCalls`, `maxPlanSteps` |
| Think only where it pays | thinking per stage | `stageThinking` |
| Cheaper model for summaries | compaction and the answer use the synthesizer model | `synthesizer` stage |

## Subagents (worker_threads)

`createSubagentTool` exposes a whole agent as one tool of a parent agent: input `{ task }`, output the child's final text.

```ts
import { createAgent, createSubagentTool } from '@dudko.dev/agent'

const researcher = createSubagentTool({
  name: 'researcher',
  description: 'Research a self-contained question and report the findings',
  config: { ...childConfig }, // a full IAgentConfig for the child
  isolation: 'worker', // default; or 'in-process'
  tools: { lookup }, // host tools for the child
  maxConcurrent: 4, // parallel calls beyond this queue
  timeoutMs: 120_000,
  outputMaxChars: 8_000,
  readOnly: true, // for tool approval
})

const agent = await createAgent({ ...config, tools: { researcher } })
```

- **`'worker'`** runs each call in its own `worker_thread` (terminated afterwards), so the child's CPU work and crashes stay off the parent's event loop. Its config must be structured-cloneable — a function anywhere (`getHeaders`, `authProvider`, `fetch`, sanitizers, `persistence`, `onRequest`, native `tools`) throws, naming the field. Host tools passed as `tools` are **proxied**: the child sees their schemas, every call runs on the parent thread.
- **`'in-process'`** builds the child on this thread; `tools` are merged into its config.

Several calls in one model step run in parallel (bounded by `maxConcurrent`). The parent's abort aborts the child. The child's usage is emitted on the parent as `usage` with `phase: 'subagent'` as it happens, so it counts against the parent's limits. Parent events: `subagent.start`, `subagent.event` (each child event, long strings clipped), `subagent.complete` (`text`, `usage`), `subagent.error`.

The worker entry ships as `dist/subagent-worker.js` and is resolved next to the bundle, from the ESM and the CJS build alike.

## Autonomy

The stage prompts are written for an agent that acts on its own:

- The **planner** plans tool use whenever the tools can obtain what the request needs — a question that needs data is actionable — and never plans a step that asks the user. An ambiguous request gets the most reasonable interpretation, with the assumption written into the step.
- The **executor** never asks questions or for confirmation, looks things up with tools, picks sensible defaults and states its assumptions in the step result. It ends with `[BLOCKER]` only when a step is truly impossible (missing credentials or permissions, a denied tool, unavailable data).
- The **replanner** prefers revising around a failure over finishing with nothing, and never revises into an "ask the user" step.
- The **synthesizer** reports what was done and found, mentions assumptions, and ends with a question only when the request genuinely cannot be completed without the user.

Consent is the host's job ([tool approval](#tool-approval-and-autopilot)) — the model never asks for permission in text.

## Configuration

`createAgent(config)` accepts an [`IAgentConfig`](./src/types.ts). Highlights:

| Field | Notes |
| --- | --- |
| `providerType` | `'openai' \| 'anthropic' \| 'google' \| 'openai-compatible' \| 'xai' \| 'azure' \| 'amazon-bedrock' \| 'google-vertex' \| 'deepseek' \| 'gateway' \| 'cloudflare'`. Each provider's SDK is an **optional peerDependency** — install only the package(s) you intend to use; setting `providerType` to a missing one throws at `createAgent` time. |
| `baseURL` | Required for `openai-compatible` (point at your self-hosted server) and `azure` (point at your deployment URL). Optional for the rest. |
| `apiKey` | Required by the type, but **ignored** for `google-vertex` (which authenticates via Google ADC). |
| `providerOptions` | Escape hatch for provider-specific factory options. Spread into the SDK's `create*()` call after `baseURL` / `apiKey`, so anything documented for the underlying SDK works: e.g. `{ apiVersion, resourceName }` for Azure, `{ region, accessKeyId, secretAccessKey }` for Bedrock, `{ project, location, googleAuthOptions }` for Vertex, `{ accountId }` (or `{ binding }` inside a Worker) for Cloudflare. Per-stage override blocks have their own `providerOptions`; if absent, the top-level value is used. |
| `model` | Default model for every stage (executor / planner / synthesizer) when no per-stage override is set. |
| `planner` / `synthesizer` | Optional per-stage override blocks: `{ providerType?, baseURL?, apiKey?, model? }`. Use these to mix providers (e.g. Gemini planner, Anthropic synthesizer). Cross-provider overrides MUST set their own `apiKey`. |
| `plannerModel` / `synthesizerModel` | **Deprecated** model-only shortcuts. Equivalent to `planner: { model }` / `synthesizer: { model }`. The override block, if present, wins. |
| `mcpServers` | `Record<name, { url, headers?, getHeaders?, authProvider?, fetch?, connectTimeoutMs? } \| { command, args?, env?, cwd?, connectTimeoutMs? }>` — StreamableHTTP for remote (legacy HTTP+SSE servers are **not** supported), stdio for locally-spawned servers. |
| `tools` | Optional `ToolSet` of native AI-SDK tools registered alongside MCP-discovered ones. Names must not collide with MCP-prefixed names or the built-in tools (`createAgent` throws on conflict). Mark read-only tools with `markReadOnly(tool)`. |
| `availableTools` / `excludedTools` | Whitelist / blacklist applied to **all** tools (MCP and native). |
| `maxIterations` | Cap on **executed steps** across the run (every step counts, including those run after a `revise`). |
| `maxStepsPerTask` | Cap on LLM steps inside a single executor call (multi-step tool calling). |
| `maxRevisions` | Cap on `revise` decisions the replanner can make per run. Default `2`. |
| `replanAfter` | Replan trigger: `'failure'` (default; blocked step or a tool failure that stayed failed) \| `'always'` \| `(stepResult) => boolean \| Promise<boolean>` (bounded by `llmTimeoutMs`; falls back to `'failure'` on error). |
| `maxTotalTokens` | Soft cap on cumulative input + output tokens; checked between steps and triggers an early jump to synthesis when crossed. Legacy shortcut for `limits.maxTotalTokens` (which wins). |
| `limits` | `{ maxInputTokens?, maxOutputTokens?, maxReasoningTokens?, maxTotalTokens?, perCall?: { planner?, executor?, replanner?, synthesizer?, compaction? } }` — cumulative per-run caps (also enforced inside an executor step) and per-call output caps. See [Token limits](#token-limits-and-step-caps). |
| `maxToolCalls` | Cap on tool calls per run; further calls fail with "tool-call budget exhausted" and the run goes to synthesis. |
| `maxPlanSteps` | Hard cap on plan steps (initial and revised). Default `8`. |
| `thinking` / `stageThinking` | Reasoning for every stage / per stage (`planner`, `executor`, `replanner`, `synthesizer`). See [Thinking](#thinking-reasoning). |
| `compaction` | `{ auto?, contextWindowTokens?, thresholdTokens?, keepRecentTurns?, keepRecentSteps?, summaryMaxTokens?, maxToolOutputChars? }`. See [Compaction](#compaction). |
| `skills` | `ISkill[]` — see [Skills](#skills). |
| `toolApproval` | `{ mode?, rules?, onRequest?, timeoutMs? }` — default autopilot. See [Tool approval](#tool-approval-and-autopilot). |
| `llmTimeoutMs` / `llmMaxRetries` | Per-LLM-call timeout and retry budget. |
| `toolSelectionStrategy` | `'auto'` (default: `'all'` up to `toolSearchThreshold` tools, `'search'` above), `'all'` (every tool each step), `'plan-narrowed'` (only `step.suggestedTools`), `'search'` (built-ins + suggested + discovered, plus `find_tools`). |
| `toolSearchThreshold` | Catalogue size above which `'auto'` switches to `'search'`. Default `40`. |
| `mcpConnectTimeoutMs` | Connect + `tools/list` budget per MCP server (each server's `connectTimeoutMs` wins). Default `30000`; `0` disables. |
| `promptCaching` | `true` (default) \| `false` \| `{ ttl?: '5m' \| '1h', key? }`. See [Prompt caching](#prompt-caching). |
| `outputSanitizer` | Optional `(toolName, output) => unknown` hook to redact tool results before they reach the LLM. |
| `inputSanitizer` | Optional `(toolName, input) => unknown` hook to redact LLM-generated tool args before they hit the MCP server **and** before they appear in `step.tool-call` events. **Must be idempotent** — applied at both the event boundary and the dispatch boundary. |
| `outputSanitizer` ordering | The sanitizer runs on the **raw MCP `result.content`** (image/audio base64 still inline), **before** the agent spills binary parts to the sandbox. This favors privacy: a sanitizer that drops a sensitive image keeps the bytes out of the disk entirely. If you want post-spill sanitization (e.g. redact a path), do it in your tool wrapper instead. |
| `sandboxRoot` | Per-run sandbox subdirs are created at `<sandboxRoot>/<runId>/` for tools that spill binary content (images, audio, blob resources). Defaults to `<os.tmpdir()>/agent-sandbox`. |
| `keepSandbox` | When `true`, the per-run directory is not removed after the run completes. Default `false`. |
| `systemPrompt` | Appended to the planner, executor, replanner, and synthesizer system prompts so the same domain context (persona, language, tone) reaches every stage. |
| `failOnNoTools` | When `true`, `createAgent` throws if every configured MCP server failed to connect (otherwise the agent starts with zero tools and emits an `error`-level log). Default `false`. |
| `maxConcurrentRuns` | Hard cap on concurrent `agent.run()` calls. When reached, further calls reject synchronously. Default: unlimited. Intentionally a throw, not a queue — back-pressure belongs on the caller. |
| `persistence` | Optional `IPersistence` facade. Receives `IRunSnapshot` at run start, at every iteration boundary, and at run completion. Implementing the optional `loadRun(runId)` enables resume via `agent.run({ resumeFromRunId })`. See [`examples/persistence-sqlite.ts`](./examples/persistence-sqlite.ts) for a `node:sqlite`-backed adapter. |
| `logLevel` | `'none' \| 'error' \| 'warn' \| 'info' \| 'debug'` |

### Picking models per stage

Match each stage to the **thinking level** the role needs, not to a specific model name (vendors rename and re-tier often). When in doubt, set `model` once and let every stage inherit it — split per stage only when cost or quality becomes a real constraint.

| Stage | Thinking level | Why |
| --- | --- | --- |
| Planner / Replanner | **high** | Decomposes the task and decides when to stop or revise. A bad plan burns the whole iteration budget. |
| Synthesizer | **medium**–**high** | Reads the full trace and writes the user-visible answer. |
| Executor | **low**–**medium** | Runs one step at a time, mostly tool calls. Invoked many times per run — the natural place to optimize cost and latency, as long as tool-call reliability holds. |

Rough family mapping at the time of writing (verify against current vendor docs — examples, not recommendations):

- **High** — e.g. Anthropic Opus, Gemini Pro with thinking enabled.
- **Medium** — e.g. Anthropic Sonnet, OpenAI GPT-4.1.
- **Low** — e.g. Anthropic Haiku, Gemini Flash.

Notes:

- Replanner has no separate override — it always shares the planner's model and provider.
- A too-weak executor with flaky tool-call JSON collapses the whole loop. The **low** tier only works for models specifically tuned for tool use.
- The executor runs once per plan step (× multi-step tool calling inside each step), so it dominates per-run cost. Optimize there first.

## API

```ts
interface IAgent {
  run(options: IAgentRunOptions): Promise<IAgentRunResult>
  listTools(): { name: string; description: string; server?: string; readOnly?: boolean }[]
  listSkills(): { name: string; description: string }[]
  compact(options: { history: IConversationTurn[]; signal?: AbortSignal; force?: boolean }): Promise<{
    history: IConversationTurn[]
    summary?: string
    beforeTokens: number
    afterTokens: number
    compacted: boolean
  }>
  setToolApprovalMode(mode: ToolApprovalMode): void
  getToolApprovalMode(): ToolApprovalMode
  reconnect(): Promise<void>
  close(options?: { waitForRuns?: boolean; timeoutMs?: number }): Promise<void>
  activeRuns(): number
}
```

`IAgentRunResult` is `{ text, plan, trace, iterations, usage, compactedHistory? }`.

A single agent instance supports concurrent `run()` calls — each gets its own `runId` (via `AsyncLocalStorage`), usage accumulator, abort signal, and `onEvent`. Tools and models are shared.

Top-level exports beyond `createAgent`:

- `getCurrentRunId(): string | undefined` — read the active run's id from any code reachable from `agent.run()` (planner, executor, MCP `execute`, retry sleeps, …). Useful for correlating logs/metrics across concurrent runs on a single agent instance.
- `getCurrentRunSandbox(): string | undefined` — absolute path to the active run's sandbox directory. Native tools that need to spill binary output should write into this path so files are auto-cleaned when the run completes (set `keepSandbox: true` to retain).
- `redactHeaders(headers)` — small helper for masking `Authorization`, `X-Api-Key`, `Cookie`, etc. when logging request headers (e.g. inside an `outputSanitizer` or your own MCP transport wrapper).
- `createSubagentTool(options)` — [subagents](#subagents-worker_threads).
- `resolveThinking(setting)`, `mergeProviderOptions(...layers)` — [thinking](#thinking-reasoning).
- `checkLimits(usage, limits)`, `resolveLimits(config)`, `normalizeUsage(sdkUsage)`, `addUsage(a, b)` — [token limits](#token-limits-and-step-caps).
- `compactHistory(turns, model, opts)`, `estimateTokens(text)`, `withToolOutputLimit(tool, maxChars)`, `truncateToolModelOutput(output, maxChars)` — [compaction](#compaction).
- `parseSkillMarkdown(markdown, files?)`, `defineSkill(skill)`, `loadSkillsFromDir(dir)` — [skills](#skills).
- `markReadOnly(tool)`, `isReadOnlyTool(tool)`, `decideToolPermission(input)`, `matchToolRule(rules, name)`, `ToolDeniedError`, `ToolBudgetError` — [tool approval](#tool-approval-and-autopilot).
- `searchTools(catalog, query, opts)` — [tool search](#large-mcp-catalogs).
- `resolvePromptCaching(setting)`, `buildInstructions(system, caching)` — [prompt caching](#prompt-caching).

### Closing the agent

`close()` defaults to **immediate** teardown; in-flight runs that touch MCP after that point will fail. Pass `{ waitForRuns: true, timeoutMs }` to drain first:

```ts
await agent.close({ waitForRuns: true, timeoutMs: 60_000 })
```

## CLI

The package ships a REPL CLI as `dd-agent`. After install, npm makes it available on `node_modules/.bin/dd-agent`:

```bash
dd-agent --env-file=.env
```

`--env-file=<path>` is loaded via Node's built-in `process.loadEnvFile`, so no `dotenv` dependency is needed. Without the flag the CLI reads the ambient process env. `-h` / `--help` prints the supported flags and the in-REPL slash commands (`/status`, `/tools`, `/history`, `/reset`, `/compact`, `/autopilot`, `/approval <mode>`, `/reconnect`, `/exit`).

The newer features are env-driven too: `AGENT_THINKING` (`off | minimal | low | medium | high | xhigh | <budget tokens>`), `AGENT_MAX_INPUT_TOKENS` / `AGENT_MAX_OUTPUT_TOKENS` / `AGENT_MAX_REASONING_TOKENS` / `AGENT_MAX_TOTAL_TOKENS`, `AGENT_MAX_TOOL_CALLS`, `AGENT_TOOL_APPROVAL` (`autopilot | ask-writes | ask-all | read-only`), `AGENT_SKILLS_DIR`, `AGENT_TOOL_SELECTION_STRATEGY` (`auto | all | plan-narrowed | search`), `AGENT_CONTEXT_WINDOW_TOKENS` and `AGENT_COMPACTION=off`. The REPL prints the model's thoughts dimmed, auto-compacts its history with the same settings, and — when the approval mode asks — prompts `allow? [y]es / [n]o / [a]lways` right in the terminal; `/autopilot` toggles between autopilot and the last asking mode.

For local development against the source tree:

```bash
npm start  # node --experimental-strip-types src/cli/start.ts --env-file=.env
```

The CLI source lives in [`src/cli`](./src/cli) — see [`env.example`](./env.example) for the full list of recognized env vars.

## Build & test

```bash
npm run build         # tsup -> dist/ (ESM + CJS + .d.ts + cli.js with shebang)
npm run typecheck     # tsc --noEmit
npm test              # node --test against tests/
npm run format        # prettier --write
npm run format:check  # prettier --check
```

## Testing against a real model

`npm test` never needs a key: the integration suite drives the whole loop over
loopback against a scripted OpenAI-compatible endpoint, a real MCP server and a
real authorization server.

To run the same loop against an actual model, point it at any OpenAI-compatible
endpoint — `llama-server`, Ollama, vLLM, anything:

```bash
llama-server -m qwen2.5-1.5b-instruct-q4_k_m.gguf --port 8080 --temp 0 --jinja

AGENT_LIVE_MODEL_URL=http://127.0.0.1:8080/v1 \
  node --test --experimental-strip-types tests/live-model.test.ts
```

CI runs this as a **gate on publishing** (`live-model.yml`, wired into
`release.yml`), and on any PR that touches the dependency manifests. It asserts
mechanics only — the loop finished, the model drove the MCP tool, the arguments
parsed — never the wording, which would make it a coin flip.

## Behavior notes & limitations

- **Module formats.** ESM is the primary target; the CJS build (`dist/index.cjs`) is best-effort and depends on upstream deps (`ai`, `@ai-sdk/*`, `@modelcontextprotocol/sdk`) keeping their CJS fallbacks. If they go pure-ESM, CJS will break — the dual-format guard in [`tests/dist-loadable.test.ts`](./tests/dist-loadable.test.ts) catches the regression on the next build.
- **MCP connect failures.** By default `createAgent` is fail-tolerant: a server that can't connect is logged at `error` level and skipped. The agent still starts with whatever tools did mount. Set `failOnNoTools: true` to throw when **every** configured server failed. Servers connect concurrently, so one slow server no longer delays the ones declared after it; tools still mount in declaration order.
- **MCP tool errors.** A tool result carrying `isError: true` is surfaced as a **thrown** tool error, so the step records `ok: false` and `replanAfter: 'failure'` sees it. The error text the server returned becomes the error message (after `outputSanitizer`, if you set one).
- **MCP tool names.** Server and tool names are sanitized into `[a-zA-Z0-9_-]` (what OpenAI, Anthropic and Gemini accept) before being joined as `server__tool`, and a collision produced by that mapping gets a `_2` suffix rather than being dropped. `callTool` always uses the server's original name. If you pin `availableTools` / `excludedTools`, use the sanitized names.
- **Tool-output cap.** Since compaction landed, the model sees at most `compaction.maxToolOutputChars` (default 20 000) of each tool result; set it to `0` for the old unlimited behaviour. The trace and events keep the full output.
- **Default tool strategy.** `toolSelectionStrategy` defaults to `'auto'`, which is `'all'` (the previous default) up to 40 tools; set `'all'` explicitly to keep every tool in every step regardless of catalogue size.
- **Blocker detection.** When the executor cannot complete a step it ends its reply with the literal `[BLOCKER]` token; the agent strips the token from the surfaced summary and sets `IStepResult.blocked = true`, which triggers the replanner. The detection is structural and language-independent — works regardless of the language the executor wrote in.
- **Retry duplicates in events.** Executor LLM retries (5xx / 429 / network) restart `streamText`, so consumers may observe `step.text-delta` / `step.tool-call` / `step.tool-result` events repeated for the same step. The `retry` event with `phase: 'execute'` precedes each repeat — UIs should clear any per-step buffers on it.
- **Mid-stream thought rewrites.** Some providers (notably Gemini structured outputs) rewrite `partialObjectStream.thought` from scratch instead of appending. The agent emits a single `log`-level warning and stops streaming `plan.thought-delta` for that run; the canonical thought still arrives in `plan.created`.
- **`.npmignore` is mostly inert.** `package.json#files` is an explicit allowlist (`["dist", "README.md"]`), so `.npmignore` only affects what npm strips **inside** that allowlist. The file is kept as a backstop in case `files` is ever broadened.

## License

MIT
