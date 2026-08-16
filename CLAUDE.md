# CLAUDE.md

## Project

`@dudko.dev/agent` — tool-using planning agent over MCP servers, built on the Vercel AI SDK. TypeScript, ESM, Node ≥22.6.

## Layout

- `src/` — library + CLI source (`.ts`, imported with explicit `.ts` extensions)
- `tests/` — `node:test` suites, run via `node --experimental-strip-types`
- `dist/` — `tsup` build output (do not edit)

## Test layers

- `tests/*.test.ts` — units plus `integration.test.ts`, which runs the whole
  loop over real sockets against a scripted OpenAI-compatible endpoint, a real
  MCP server and a real authorization server (`tests/helpers/`). No key, ~5s.
- `tests/live-model.test.ts` — the same loop against a REAL model. Skipped
  unless `AGENT_LIVE_MODEL_URL` points at an OpenAI-compatible endpoint; CI
  starts one via `live-model.yml`. Asserts mechanics only (the loop finished, a
  tool was driven, arguments parsed) — never wording or plan shape, or the
  suite becomes a coin flip nobody trusts.

## Mandatory checks

After **any** change to `.ts` files in `src/` or `tests/`, run:

```bash
npm run typecheck
npm run format:check
npm run build
npm test
```

Do not consider a task done until all four exit cleanly. Run them with the `Bash` tool, do not infer success from "the change looks right".

If `npm install` is needed (e.g. lockfile changed), run it with `--no-audit --no-fund` and ensure it returned 0 before running checks.

## Conventions

- Use `.ts` extensions in relative imports (project relies on `--experimental-strip-types`).
- Zod v4 is used; when passing heterogeneous schemas through a shared array/iterable, type the collection as `z.ZodType` to avoid union-narrowing errors.
- Anthropic's native structured output rejects `maxItems` on arrays — never add `.max()` to Zod arrays that flow into structured output. The guard test in `tests/anthropic-schema-compat.test.ts` enforces this.

## Boundaries

- Do not bump the package `version` manually. Versioning is handled by the autoupdate flow / maintainer on release.
- Do not edit `.github/workflows/release.yml` unless explicitly asked — it is the npm-trusted-publisher release pipeline.
- Do not push to `main` directly. Always work on the existing branch you were summoned to.

## When you are working on an autoupdate PR

- Branch will be `chore/autoupdate-<run_id>`.
- Goal: bring `npm run typecheck && npm run format:check && npm run build && npm test` to green.
- Push compatibility fixes onto this branch. Each push re-runs the `CI` workflow automatically once the PR is open.
- If a fix is impossible without changing product behavior, stop and leave a comment explaining what's blocked rather than guessing.

## CI quirks specific to this repo

This repo follows the unified `autoupdate-with-claude` baseline (same template across siblings). Several workarounds are intentional:
- `autoupdate.yml` uses `GITHUB_TOKEN` and explicitly dispatches `test.yml` (the `CI` workflow) after PR creation, because events created via `GITHUB_TOKEN` don't trigger `pull_request` workflows.
- `autoupdate.yml` dispatches `claude.yml` directly via `workflow_dispatch` instead of relying on an `@claude` PR comment.
- Releases stay wired through `release.yml` (npm Trusted Publisher), which fires via `workflow_run` after a successful CI on `main`. There is no `release-on-version-bump.yml` here — it would conflict with the existing tag/publish chain.
- `release.yml` now `needs:` the `live-model.yml` workflow: a smoke test against a real model (llama.cpp on the runner, no key) gates the publish. It also runs on PRs that touch `package.json` / `package-lock.json`, which is where dependency drift arrives. Deliberately NOT nightly — a 3am failure on yesterday's commit gets ignored, and the question it answers matters at publish time. `LLAMA_IMAGE` / `MODEL_*` are pinned so a rerun downloads nothing and behaves the same; bump them on purpose. `LLAMA_IMAGE` is pinned **by digest**, not by tag: the `server-bNNNN` tags stop at b5350 because the project renamed its tags, so the newest-looking tag was a year-old build that rejects streamed tool calls (`Cannot use tools with stream`) and blocked a release. Resolve `ghcr.io/ggml-org/llama.cpp:server` and paste the digest. A preflight step asserts the server can stream a tool call, so that failure names itself instead of dying inside the agent. 3B is the measured floor — a 1.5B answers from imagination instead of calling the tool (0/3 runs touched it).
- All actions pinned to the `@v4` line because the runner image currently lacks `externals/node24`, breaking post-cleanup of `@v5/@v6` actions.

Do **not** "fix" any of the above by replacing dispatch calls with comment-based mentions, or by bumping action versions back to `@v5/@v6`.
