import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import test from 'node:test'
import { createAgent } from '../src/index.ts'
import type { IAgentConfig } from '../src/types.ts'

const HANGING_MCP = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  'fixtures/hanging-mcp.mjs',
)

const baseConfig = (): IAgentConfig => ({
  clientName: 'close-test',
  providerType: 'openai',
  apiKey: 'sk-test',
  model: 'm',
  // The fixture child speaks just enough MCP to satisfy connectMcpServers
  // (initialize + empty tools/list), then ignores SIGTERM. Triggering the
  // SDK's stdio close path is what gives the timeout something to clip.
  mcpServers: { hang: { command: 'node', args: [HANGING_MCP] } },
  maxIterations: 1,
  maxStepsPerTask: 1,
  logLevel: 'none',
})

test('agent.close() resolves within timeoutMs even if MCP teardown stalls', async () => {
  const agent = await createAgent(baseConfig())
  const start = Date.now()
  // The SDK's own staged stdio close (stdin.end -> 2s -> SIGTERM -> 2s ->
  // SIGKILL) takes ~4s when the child ignores SIGTERM. Our 200ms cap MUST
  // win the race well before that.
  await agent.close({ timeoutMs: 200 })
  const elapsed = Date.now() - start
  assert.ok(
    elapsed < 1_500,
    `close should respect timeoutMs=200; took ${elapsed}ms (SDK fallback would be ~4000)`,
  )
})

test('agent.close() emits a warn-level log when MCP teardown is timed out', async () => {
  const messages: string[] = []
  const agent = await createAgent(baseConfig(), (event) => {
    if (event.type === 'log' && event.level === 'warn') {
      messages.push(event.message)
    }
  })
  await agent.close({ timeoutMs: 200 })
  // The warning is what tells operators a transport was abandoned rather
  // than properly closed - asserting on the exact wording is fine because
  // it is part of the contract operators are expected to grep for.
  assert.ok(
    messages.some((m) => m.includes('MCP teardown exceeded')),
    `expected timeout warning, got: ${messages.join(' | ')}`,
  )
})
