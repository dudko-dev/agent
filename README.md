# @dudko.dev/agent

A small, opinionated planning agent that uses tools exposed via [Model Context Protocol (MCP)](https://modelcontextprotocol.io/) servers, built on top of the [Vercel AI SDK](https://sdk.vercel.ai/).

The agent runs a plan → execute → replan → synthesize loop:

1. **Plan** — the planner LLM produces a structured plan (a thought + ordered steps with optional suggested tools).
2. **Execute** — the executor LLM runs each step, calling MCP tools through the Vercel AI SDK.
3. **Replan** — after each step the replanner decides whether to continue, revise the plan, or finish.
4. **Synthesize** — once finished, the synthesizer LLM writes the final answer for the user.

Multi-provider out of the box: OpenAI, Anthropic, Google, and any OpenAI-compatible endpoint. Streaming events, per-run cancellation via `AbortSignal`, token budgets, retry/timeout, and concurrent runs on a single agent instance.

## Install

```bash
npm install @dudko.dev/agent
```

Requires Node.js **22.6+**.

## Quick start

```ts
import { createAgent } from '@dudko.dev/agent'

const agent = await createAgent({
  clientName: 'my-app',
  providerType: 'openai',
  apiKey: process.env.OPENAI_API_KEY!,
  model: 'gpt-4.1-mini',
  mcpServers: {
    docs: { url: 'https://mcp.example.com/sse' },
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

## Configuration

`createAgent(config)` accepts an [`IAgentConfig`](./src/types.ts). Highlights:

| Field | Notes |
| --- | --- |
| `providerType` | `'openai' \| 'anthropic' \| 'google' \| 'openai-compatible'` |
| `baseURL` | Required for `openai-compatible`; optional for the rest. |
| `model` / `plannerModel` / `synthesizerModel` | The latter two default to `model`. |
| `mcpServers` | `Record<name, { url, headers?, getHeaders? } \| { command, args?, env?, cwd? }>` — HTTP/SSE for remote, stdio for locally-spawned servers. |
| `tools` | Optional `ToolSet` of native AI-SDK tools registered alongside MCP-discovered ones. Names must not collide with MCP-prefixed names (`createAgent` throws on conflict). |
| `availableTools` / `excludedTools` | Whitelist / blacklist applied to **all** tools (MCP and native). |
| `maxIterations` | Cap on **executed steps** across the run (every step counts, including those run after a `revise`). |
| `maxStepsPerTask` | Cap on LLM steps inside a single executor call (multi-step tool calling). |
| `maxRevisions` | Cap on `revise` decisions the replanner can make per run. Default `2`. |
| `maxTotalTokens` | Soft cap on cumulative input + output tokens; checked between steps and triggers an early jump to synthesis when crossed. |
| `llmTimeoutMs` / `llmMaxRetries` | Per-LLM-call timeout and retry budget. |
| `toolSelectionStrategy` | `'all'` (default) gives the executor every tool each step; `'plan-narrowed'` exposes only `step.suggestedTools`. |
| `outputSanitizer` | Optional `(toolName, output) => unknown` hook to redact tool results before they reach the LLM. |
| `inputSanitizer` | Optional `(toolName, input) => unknown` hook to redact LLM-generated tool args before they hit the MCP server **and** before they appear in `step.tool-call` events. **Must be idempotent** — applied at both the event boundary and the dispatch boundary. |
| `sandboxRoot` | Per-run sandbox subdirs are created at `<sandboxRoot>/<runId>/` for tools that spill binary content (images, audio, blob resources). Defaults to `<os.tmpdir()>/agent-sandbox`. |
| `keepSandbox` | When `true`, the per-run directory is not removed after the run completes. Default `false`. |
| `systemPrompt` | Appended to the planner, executor, replanner, and synthesizer system prompts so the same domain context (persona, language, tone) reaches every stage. |
| `failOnNoTools` | When `true`, `createAgent` throws if every configured MCP server failed to connect (otherwise the agent starts with zero tools and emits an `error`-level log). Default `false`. |
| `logLevel` | `'none' \| 'error' \| 'warn' \| 'info' \| 'debug'` |

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
- **MCP connect failures.** By default `createAgent` is fail-tolerant: a server that can't connect is logged at `error` level and skipped. The agent still starts with whatever tools did mount. Set `failOnNoTools: true` to throw when **every** configured server failed.
- **Blocker detection.** When the executor cannot complete a step it ends its reply with the literal `[BLOCKER]` token; the agent strips the token from the surfaced summary and sets `IStepResult.blocked = true`, which triggers the replanner. The detection is structural and language-independent — works regardless of the language the executor wrote in.
- **Retry duplicates in events.** Executor LLM retries (5xx / 429 / network) restart `streamText`, so consumers may observe `step.text-delta` / `step.tool-call` / `step.tool-result` events repeated for the same step. The `retry` event with `phase: 'execute'` precedes each repeat — UIs should clear any per-step buffers on it.
- **Mid-stream thought rewrites.** Some providers (notably Gemini structured outputs) rewrite `partialObjectStream.thought` from scratch instead of appending. The agent emits a single `log`-level warning and stops streaming `plan.thought-delta` for that run; the canonical thought still arrives in `plan.created`.
- **`.npmignore` is mostly inert.** `package.json#files` is an explicit allowlist (`["dist", "README.md"]`), so `.npmignore` only affects what npm strips **inside** that allowlist. The file is kept as a backstop in case `files` is ever broadened.

## License

MIT
