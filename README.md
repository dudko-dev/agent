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

Multi-provider out of the box: OpenAI, Anthropic, Google (Gemini), xAI (Grok), Azure OpenAI, Amazon Bedrock, Google Vertex, DeepSeek, Vercel AI Gateway, Cloudflare Workers AI, and any OpenAI-compatible endpoint. Streaming events, per-run cancellation via `AbortSignal`, token budgets, retry/timeout, and concurrent runs on a single agent instance.

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

Pass an event handler as the second argument to `createAgent`, or per run via `onEvent`. Events include plan deltas, step starts and tool calls, replanner decisions, retries, budget breaches, the streamed final answer, and errors. See [`AgentEvent`](./src/types.ts) for the full union.

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
- **Caps inherit.** `iterations` and `revisions` carry over, so per-run caps still apply across the boundary.
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
| `mcpServers` | `Record<name, { url, headers?, getHeaders?, authProvider?, fetch? } \| { command, args?, env?, cwd? }>` — StreamableHTTP for remote (legacy HTTP+SSE servers are **not** supported), stdio for locally-spawned servers. |
| `tools` | Optional `ToolSet` of native AI-SDK tools registered alongside MCP-discovered ones. Names must not collide with MCP-prefixed names (`createAgent` throws on conflict). |
| `availableTools` / `excludedTools` | Whitelist / blacklist applied to **all** tools (MCP and native). |
| `maxIterations` | Cap on **executed steps** across the run (every step counts, including those run after a `revise`). |
| `maxStepsPerTask` | Cap on LLM steps inside a single executor call (multi-step tool calling). |
| `maxRevisions` | Cap on `revise` decisions the replanner can make per run. Default `2`. |
| `replanAfter` | Replan trigger: `'failure'` (default; blocked step or a tool failure that stayed failed) \| `'always'` \| `(stepResult) => boolean \| Promise<boolean>` (bounded by `llmTimeoutMs`; falls back to `'failure'` on error). |
| `maxTotalTokens` | Soft cap on cumulative input + output tokens; checked between steps and triggers an early jump to synthesis when crossed. |
| `llmTimeoutMs` / `llmMaxRetries` | Per-LLM-call timeout and retry budget. |
| `toolSelectionStrategy` | `'all'` (default) gives the executor every tool each step; `'plan-narrowed'` exposes only `step.suggestedTools`. |
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
  listTools(): { name: string; description: string }[]
  reconnect(): Promise<void>
  close(options?: { waitForRuns?: boolean; timeoutMs?: number }): Promise<void>
  activeRuns(): number
}
```

A single agent instance supports concurrent `run()` calls — each gets its own `runId` (via `AsyncLocalStorage`), usage accumulator, abort signal, and `onEvent`. Tools and models are shared.

Top-level exports beyond `createAgent`:

- `getCurrentRunId(): string | undefined` — read the active run's id from any code reachable from `agent.run()` (planner, executor, MCP `execute`, retry sleeps, …). Useful for correlating logs/metrics across concurrent runs on a single agent instance.
- `getCurrentRunSandbox(): string | undefined` — absolute path to the active run's sandbox directory. Native tools that need to spill binary output should write into this path so files are auto-cleaned when the run completes (set `keepSandbox: true` to retain).
- `redactHeaders(headers)` — small helper for masking `Authorization`, `X-Api-Key`, `Cookie`, etc. when logging request headers (e.g. inside an `outputSanitizer` or your own MCP transport wrapper).

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

`--env-file=<path>` is loaded via Node's built-in `process.loadEnvFile`, so no `dotenv` dependency is needed. Without the flag the CLI reads the ambient process env. `-h` / `--help` prints the supported flags and the in-REPL slash commands (`/status`, `/tools`, `/history`, `/reset`, `/reconnect`, `/exit`).

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

## Behavior notes & limitations

- **Module formats.** ESM is the primary target; the CJS build (`dist/index.cjs`) is best-effort and depends on upstream deps (`ai`, `@ai-sdk/*`, `@modelcontextprotocol/sdk`) keeping their CJS fallbacks. If they go pure-ESM, CJS will break — the dual-format guard in [`tests/dist-loadable.test.ts`](./tests/dist-loadable.test.ts) catches the regression on the next build.
- **MCP connect failures.** By default `createAgent` is fail-tolerant: a server that can't connect is logged at `error` level and skipped. The agent still starts with whatever tools did mount. Set `failOnNoTools: true` to throw when **every** configured server failed. Servers connect concurrently, so one slow server no longer delays the ones declared after it; tools still mount in declaration order.
- **MCP tool errors.** A tool result carrying `isError: true` is surfaced as a **thrown** tool error, so the step records `ok: false` and `replanAfter: 'failure'` sees it. The error text the server returned becomes the error message (after `outputSanitizer`, if you set one).
- **MCP tool names.** Server and tool names are sanitized into `[a-zA-Z0-9_-]` (what OpenAI, Anthropic and Gemini accept) before being joined as `server__tool`, and a collision produced by that mapping gets a `_2` suffix rather than being dropped. `callTool` always uses the server's original name. If you pin `availableTools` / `excludedTools`, use the sanitized names.
- **Blocker detection.** When the executor cannot complete a step it ends its reply with the literal `[BLOCKER]` token; the agent strips the token from the surfaced summary and sets `IStepResult.blocked = true`, which triggers the replanner. The detection is structural and language-independent — works regardless of the language the executor wrote in.
- **Retry duplicates in events.** Executor LLM retries (5xx / 429 / network) restart `streamText`, so consumers may observe `step.text-delta` / `step.tool-call` / `step.tool-result` events repeated for the same step. The `retry` event with `phase: 'execute'` precedes each repeat — UIs should clear any per-step buffers on it.
- **Mid-stream thought rewrites.** Some providers (notably Gemini structured outputs) rewrite `partialObjectStream.thought` from scratch instead of appending. The agent emits a single `log`-level warning and stops streaming `plan.thought-delta` for that run; the canonical thought still arrives in `plan.created`.
- **`.npmignore` is mostly inert.** `package.json#files` is an explicit allowlist (`["dist", "README.md"]`), so `.npmignore` only affects what npm strips **inside** that allowlist. The file is kept as a backstop in case `files` is ever broadened.

## License

MIT
