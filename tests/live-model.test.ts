import assert from 'node:assert/strict'
import test from 'node:test'
import { createAgent } from '../src/index.ts'
import { startLocalMcp } from './helpers/mcp-server.ts'

/**
 * The same loop as `integration.test.ts`, but driven by a REAL model behind an
 * OpenAI-compatible endpoint instead of a scripted one.
 *
 * Skipped unless `AGENT_LIVE_MODEL_URL` points at a server (CI starts a small
 * local model; locally, `llama-server`, Ollama or anything else with a /v1
 * endpoint will do). No hosted API and no key is involved.
 *
 * ── WHAT THIS MAY AND MAY NOT ASSERT ──
 * Only mechanics: the loop reached a final answer, and the model actually
 * drove the MCP tool with arguments that parsed. Asserting the wording, the
 * plan's shape or the tool's arguments would be asserting the model's
 * judgement, which changes with every weight and every sampler — that is how
 * a suite ends up disabled. What is being pinned here is that a real model's
 * output survives the whole path: structured-output parsing, tool dispatch
 * over MCP, and the loop's exit conditions.
 */

const LIVE_URL = process.env.AGENT_LIVE_MODEL_URL
const LIVE_MODEL = process.env.AGENT_LIVE_MODEL ?? 'local'

test(
  'a real local model plans, calls an MCP tool, and finishes',
  { skip: LIVE_URL ? false : 'set AGENT_LIVE_MODEL_URL to run', timeout: 600_000 },
  async () => {
    const mcp = await startLocalMcp()
    const logs: string[] = []
    try {
      const agent = await createAgent(
        {
          clientName: 'agent-live-model-test',
          providerType: 'openai-compatible',
          baseURL: LIVE_URL!,
          apiKey: 'not-a-real-key',
          model: LIVE_MODEL,
          mcpServers: { files: { url: mcp.url } },
          // A small model wanders; keep it on a short leash so a bad run ends
          // in a failed assertion rather than a burned CI minute budget.
          maxIterations: 3,
          maxStepsPerTask: 4,
          llmTimeoutMs: 180_000,
          logLevel: 'none',
        },
        (event) => {
          if (event.type === 'log') logs.push(event.message)
        },
      )

      try {
        const result = await agent.run({
          input: 'Use the echo tool to echo the word "hello", then tell me what it returned.',
        })

        assert.ok(result.text.trim().length > 0, 'the run produced a final answer')
        assert.ok(result.plan.steps.length > 0, 'the model produced a parseable plan')
        assert.ok(
          mcp.calls.some((c) => c.name === 'echo'),
          `the model drove the MCP tool (calls: ${JSON.stringify(mcp.calls)})`,
        )
        const echo = mcp.calls.find((c) => c.name === 'echo')
        assert.equal(
          typeof (echo?.args as { text?: unknown }).text,
          'string',
          'the tool arguments parsed into the declared schema',
        )
      } finally {
        await agent.close()
      }
    } finally {
      await mcp.close()
    }
  },
)
