import { stdin as input, stdout as output } from 'node:process'
import { createInterface } from 'node:readline/promises'
import type { AgentEvent, IConversationTurn } from '../index.ts'
import { createAgent } from '../index.ts'
import { loadConfig } from './config.ts'

const HISTORY_LIMIT = 16

const truncate = (s: string, n = 240): string => {
  const flat = s.replace(/\s+/g, ' ').trim()
  return flat.length > n ? `${flat.slice(0, n)}...` : flat
}

const formatJson = (v: unknown): string => {
  try {
    return truncate(JSON.stringify(v))
  } catch {
    return String(v)
  }
}

export const runRepl = async (): Promise<void> => {
  const config = loadConfig()
  const mcpNames = Object.keys(config.mcpServers)

  console.log(
    `[session] model=${config.model} planner=${config.plannerModel ?? config.model} synth=${config.synthesizerModel ?? config.model} provider=${config.providerType}`,
  )
  console.log(
    `[session] maxIterations=${config.maxIterations} maxStepsPerTask=${config.maxStepsPerTask} timeoutMs=${config.llmTimeoutMs ?? 'none'} retries=${config.llmMaxRetries ?? 2}`,
  )
  console.log(`[mcp]     servers=${mcpNames.length ? mcpNames.join(', ') : '(none)'}`)
  console.log('[hint]    commands: /status, /tools, /history, /reset, /reconnect, /exit\n')

  let streamingFinal = false
  let streamingThought = false

  const onEvent = (event: AgentEvent): void => {
    switch (event.type) {
      case 'log':
        console.log(`[${event.level}] ${event.message}`)
        break
      case 'plan.thought-delta':
        if (!streamingThought) {
          process.stdout.write('\n[plan]    ')
          streamingThought = true
        }
        process.stdout.write(event.delta)
        break
      case 'plan.created':
        if (streamingThought) {
          process.stdout.write('\n')
          streamingThought = false
        } else {
          console.log(`\n[plan]    ${event.plan.thought}`)
        }
        for (const [i, s] of event.plan.steps.entries()) {
          const tools = s.suggestedTools?.length ? `  (tools: ${s.suggestedTools.join(', ')})` : ''
          console.log(`          ${i + 1}. ${s.description}${tools}`)
        }
        break
      case 'plan.revised':
        console.log(`\n[replan]  reason=${event.reason}`)
        for (const [i, s] of event.plan.steps.entries()) {
          console.log(`          ${i + 1}. ${s.description}`)
        }
        break
      case 'step.start':
        console.log(`\n[step ${event.index + 1}] ${event.step.description}`)
        break
      case 'step.tool-call':
        console.log(`  -> ${event.name} ${formatJson(event.input)}`)
        break
      case 'step.tool-result': {
        const status = event.ok ? 'ok' : 'fail'
        console.log(`  <- ${event.name} ${status} ${formatJson(event.output)}`)
        break
      }
      case 'step.complete':
        console.log(
          `  = ${truncate(event.result.summary, 400)} (${event.result.durationMs}ms, ${event.result.toolCalls.length} tool calls)`,
        )
        break
      case 'replan.decision':
        if (event.mode !== 'continue') {
          console.log(`[replan]  ${event.mode} (${event.cause}): ${event.reason}`)
        }
        break
      case 'usage':
        // Per-run total surfaces in [meta] via result.usage. We do not
        // accumulate here.
        break
      case 'retry':
        // If the planner is retrying, the partial thought we already streamed
        // is no longer authoritative - flush the line and reset the flag.
        if (event.phase === 'plan' && streamingThought) {
          process.stdout.write('\n')
          streamingThought = false
        }
        console.log(`[retry]   ${event.phase} attempt=${event.attempt}: ${event.error}`)
        break
      case 'budget.exceeded':
        console.log(`[budget]  token cap reached: ${event.tokens}/${event.cap} - finishing early`)
        break
      case 'revisions.exceeded':
        console.log(`[budget]  max ${event.cap} replan-revisions reached - finishing early`)
        break
      case 'final.text-delta':
        if (!streamingFinal) {
          process.stdout.write('\nassistant> ')
          streamingFinal = true
        }
        process.stdout.write(event.delta)
        break
      case 'final':
        if (streamingFinal) {
          process.stdout.write('\n\n')
          streamingFinal = false
        } else {
          console.log(`\nassistant> ${event.text}\n`)
        }
        break
      case 'error':
        // A planner failure may interrupt mid-stream. Flush the partial
        // [plan] line so the next output (fallback plan or error) starts
        // cleanly, mirroring what the retry case does.
        if (event.phase === 'plan' && streamingThought) {
          process.stdout.write('\n')
          streamingThought = false
        }
        console.error(`[error] (${event.phase}) ${event.error.message}`)
        break
    }
  }

  const agent = await createAgent(config, onEvent)

  const tools = agent.listTools()
  console.log(
    `[tools]   available=${tools.length}${tools.length ? `: ${tools.map((t) => t.name).join(', ')}` : ''}`,
  )

  const rl = createInterface({ input, output })
  const history: IConversationTurn[] = []
  let abortController: AbortController | null = null

  // Use process-level SIGINT instead of rl.on('SIGINT'): the latter only fires
  // while rl.question() is actively reading. During `await agent.run(...)`
  // readline is idle, so Ctrl-C would otherwise hit Node's default handler
  // (terminate). With this listener Ctrl-C cancels the run if one is active,
  // and gracefully closes the REPL otherwise.
  const onSigInt = () => {
    if (abortController) {
      console.log('\n[abort] cancelling current run...')
      abortController.abort()
    } else {
      rl.close()
    }
  }
  process.on('SIGINT', onSigInt)

  try {
    while (true) {
      let prompt: string
      try {
        prompt = (await rl.question('\nyou> ')).trim()
      } catch {
        break
      }
      if (!prompt) {
        continue
      }
      if (prompt === '/exit' || prompt === '/quit') {
        break
      }
      if (prompt === '/tools') {
        if (tools.length === 0) {
          console.log('[tools] (none)')
        } else {
          for (const t of tools) {
            console.log(`  - ${t.name}: ${truncate(t.description, 200)}`)
          }
        }
        continue
      }
      if (prompt === '/status') {
        console.log(`[status] model=${config.model} planner=${config.plannerModel ?? config.model}`)
        console.log(
          `[status] tools=${tools.length} mcp=${mcpNames.join(', ') || '(none)'} historyTurns=${history.length}`,
        )
        continue
      }
      if (prompt === '/history') {
        if (history.length === 0) {
          console.log('[history] (empty)')
        } else {
          for (const t of history) {
            console.log(`  ${t.role}: ${truncate(t.content, 200)}`)
          }
        }
        continue
      }
      if (prompt === '/reset') {
        history.length = 0
        console.log('[history] cleared')
        continue
      }
      if (prompt === '/reconnect') {
        try {
          await agent.reconnect()
          const fresh = agent.listTools()
          tools.length = 0
          for (const t of fresh) {
            tools.push(t)
          }
          console.log(`[mcp]     reconnected, ${tools.length} tools available`)
        } catch (err) {
          console.error('[error] reconnect failed:', (err as Error).message)
        }
        continue
      }

      streamingFinal = false
      streamingThought = false
      abortController = new AbortController()
      try {
        const result = await agent.run({
          input: prompt,
          history,
          signal: abortController.signal,
        })
        history.push({ role: 'user', content: prompt })
        history.push({ role: 'assistant', content: result.text })
        while (history.length > HISTORY_LIMIT) {
          history.shift()
        }
        console.log(
          `[meta]    iterations=${result.iterations} steps=${result.trace.length} tokens=${result.usage.totalTokens} (in=${result.usage.inputTokens} out=${result.usage.outputTokens})`,
        )
      } catch (err) {
        if ((err as { name?: string })?.name === 'AbortError') {
          console.log('[abort] run cancelled')
        } else {
          console.error('[error]', (err as Error).message)
        }
      } finally {
        abortController = null
      }
    }
  } finally {
    process.off('SIGINT', onSigInt)
    rl.close()
    await agent.close().catch((err: unknown) => console.error('[cleanup] agent', err))
  }
}
