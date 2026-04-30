#!/usr/bin/env node
// Minimal MCP stdio server that completes the initialize handshake (so the
// agent counts the connection as live and adds it to the close set), but
// then ignores SIGTERM and stays alive indefinitely. Used by
// tests/close.test.ts to exercise agent.close() timeout behavior. Has a
// hard self-destruct after 8s as a safety net so a test crash never leaves
// an orphaned process running on the developer's machine.

import { createInterface } from 'node:readline'

process.on('SIGTERM', () => {})

const rl = createInterface({ input: process.stdin })
const send = (msg) => process.stdout.write(JSON.stringify(msg) + '\n')

rl.on('line', (line) => {
  let req
  try {
    req = JSON.parse(line)
  } catch {
    return
  }
  if (typeof req.method !== 'string') {
    return
  }
  if (req.method === 'initialize') {
    send({
      jsonrpc: '2.0',
      id: req.id,
      result: {
        protocolVersion: req.params?.protocolVersion ?? '2024-11-05',
        capabilities: { tools: {} },
        serverInfo: { name: 'hanging-mcp', version: '0.0.1' },
      },
    })
    return
  }
  if (req.method === 'tools/list') {
    send({ jsonrpc: '2.0', id: req.id, result: { tools: [] } })
    return
  }
  // Ignore everything else (shutdown notifications, etc.).
})

// Keep the loop alive even after stdin EOF. SIGKILL eventually wins, but
// the timer also self-terminates the process so an abandoned child does
// not linger past 8 seconds.
const keepAlive = setInterval(() => {}, 60_000)
setTimeout(() => {
  clearInterval(keepAlive)
  process.exit(0)
}, 8_000).unref()
