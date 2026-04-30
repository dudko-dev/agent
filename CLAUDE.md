# CLAUDE.md

## Project

`@dudko.dev/agent` — tool-using planning agent over MCP servers, built on the Vercel AI SDK. TypeScript, ESM, Node ≥22.6.

## Layout

- `src/` — library + CLI source (`.ts`, imported with explicit `.ts` extensions)
- `tests/` — `node:test` suites, run via `node --experimental-strip-types`
- `dist/` — `tsup` build output (do not edit)

## Mandatory checks

After **any** change to `.ts` files in `src/` or `tests/`, run:

```bash
npm run typecheck
```

Do not consider a task done until `tsc --noEmit` exits cleanly. If the change touches runtime behavior, also run `npm test`.

## Conventions

- Use `.ts` extensions in relative imports (project relies on `--experimental-strip-types`).
- Zod v4 is used; when passing heterogeneous schemas through a shared array/iterable, type the collection as `z.ZodType` to avoid union-narrowing errors.
- Anthropic's native structured output rejects `maxItems` on arrays — never add `.max()` to Zod arrays that flow into structured output. The guard test in `tests/anthropic-schema-compat.test.ts` enforces this.
