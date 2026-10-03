import { stdin as input, stdout as output } from 'node:process'
import { createInterface } from 'node:readline/promises'
import type {
  AgentEvent,
  IConversationTurn,
  IToolApprovalRequest,
  ThinkingSetting,
  ToolApprovalDecision,
  ToolApprovalMode,
} from '../index.ts'
import { createAgent, loadSkillsFromDir } from '../index.ts'
import { isSummaryTurn } from '../compaction.ts'
import { loadConfig, skillsDirFromEnv } from './config.ts'

const HISTORY_LIMIT = 16
const APPROVAL_MODES: readonly ToolApprovalMode[] = [
  'autopilot',
  'ask-writes',
  'ask-all',
  'read-only',
]

// ANSI dim for the model's thoughts; plain text when stdout is not a TTY.
const DIM = output.isTTY ? '\x1b[2m' : ''
const UNDIM = output.isTTY ? '\x1b[22m' : ''

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

const describeThinking = (t: ThinkingSetting | undefined): string => {
  if (t === undefined || t === false) {
    return 'provider default'
  }
  if (t === true) {
    return 'medium'
  }
  if (typeof t === 'string') {
    return t
  }
  return `${t.level ?? 'medium'}${t.budgetTokens ? ` (budget ${t.budgetTokens})` : ''}`
}

// Keep the REPL history bounded: drop the oldest turns but never the
// compaction summary at the head (it stands for everything before it).
const trimHistory = (history: IConversationTurn[]): void => {
  while (history.length > HISTORY_LIMIT) {
    const at = history.length && isSummaryTurn(history[0]) ? 1 : 0
    history.splice(at, 1)
  }
}

export const runRepl = async (): Promise<void> => {
  const config = loadConfig()
  const skillsDir = skillsDirFromEnv()
  if (skillsDir) {
    config.skills = await loadSkillsFromDir(skillsDir)
  }
  const mcpNames = Object.keys(config.mcpServers)

  // Resolve effective per-stage models: the override block wins over the
  // legacy single-string shortcut, which in turn wins over the top-level model.
  const plannerModelEff = config.planner?.model ?? config.plannerModel ?? config.model
  const synthModelEff = config.synthesizer?.model ?? config.synthesizerModel ?? config.model
  console.log(
    `[session] model=${config.model} planner=${plannerModelEff} synth=${synthModelEff} provider=${config.providerType}`,
  )
  console.log(
    `[session] maxIterations=${config.maxIterations} maxStepsPerTask=${config.maxStepsPerTask} timeoutMs=${config.llmTimeoutMs ?? 'none'} retries=${config.llmMaxRetries ?? 2}`,
  )
  console.log(
    `[session] thinking=${describeThinking(config.thinking)} approval=${config.toolApproval?.mode ?? 'autopilot'} skills=${config.skills?.length ?? 0}`,
  )
  console.log(`[mcp]     servers=${mcpNames.length ? mcpNames.join(', ') : '(none)'}`)
  console.log(
    '[hint]    commands: /status, /tools, /history, /reset, /compact, /autopilot, /approval <mode>, /reconnect, /exit\n',
  )

  // Which stream (if any) currently owns the output line.
  let streaming: 'none' | 'thought' | 'reasoning' | 'final' = 'none'
  const endLine = (): void => {
    if (streaming !== 'none') {
      process.stdout.write(streaming === 'reasoning' ? `${UNDIM}\n` : '\n')
      streaming = 'none'
    }
  }

  const onEvent = (event: AgentEvent): void => {
    switch (event.type) {
      case 'log':
        endLine()
        console.log(`[${event.level}] ${event.message}`)
        break
      case 'plan.thought-delta':
        if (streaming !== 'thought') {
          endLine()
          process.stdout.write('\n[plan]    ')
          streaming = 'thought'
        }
        process.stdout.write(event.delta)
        break
      case 'plan.step-added':
        // Show the partial step as soon as the planner has streamed enough
        // to display. The same step may be revised before plan.created lands;
        // we re-render from plan.created when it arrives (cleaner than tracking
        // partial->final diffs in the REPL).
        endLine()
        console.log(`          ${event.index + 1}. ${event.step.description}`)
        break
      case 'plan.created':
        if (streaming === 'thought') {
          endLine()
        } else {
          endLine()
          console.log(`\n[plan]    ${event.plan.thought}`)
        }
        for (const [i, s] of event.plan.steps.entries()) {
          const tools = s.suggestedTools?.length ? `  (tools: ${s.suggestedTools.join(', ')})` : ''
          console.log(`          ${i + 1}. ${s.description}${tools}`)
        }
        break
      case 'plan.revised':
        endLine()
        console.log(`\n[replan]  reason=${event.reason}`)
        for (const [i, s] of event.plan.steps.entries()) {
          console.log(`          ${i + 1}. ${s.description}`)
        }
        break
      case 'skill.activated':
        endLine()
        console.log(`[skill]   ${event.name} (by ${event.by})`)
        break
      case 'step.start':
        endLine()
        console.log(`\n[step ${event.index + 1}] ${event.step.description}`)
        break
      case 'step.reasoning-delta':
      case 'final.reasoning-delta':
        if (streaming !== 'reasoning') {
          endLine()
          process.stdout.write(`${DIM}[think]   `)
          streaming = 'reasoning'
        }
        process.stdout.write(event.delta)
        break
      case 'step.tool-call':
        endLine()
        console.log(`  -> ${event.name} ${formatJson(event.input)}`)
        break
      case 'step.tool-result': {
        endLine()
        const status = event.ok ? 'ok' : 'fail'
        console.log(`  <- ${event.name} ${status} ${formatJson(event.output)}`)
        break
      }
      case 'tools.discovered':
        endLine()
        console.log(
          `  ?? find_tools "${event.query}" -> ${event.names.length ? event.names.join(', ') : '(nothing)'}`,
        )
        break
      case 'tool.approval-resolved':
        // Prompted decisions are visible at the prompt; show the automatic ones.
        if (event.automatic && !event.approved) {
          endLine()
          console.log(`  !! ${event.name} denied: ${event.reason ?? 'no reason'}`)
        }
        break
      case 'subagent.start':
        endLine()
        console.log(`  >> subagent ${event.name}: ${truncate(event.task, 160)}`)
        break
      case 'subagent.complete':
        endLine()
        console.log(
          `  << subagent ${event.name} done (${event.usage.totalTokens} tokens): ${truncate(event.text, 160)}`,
        )
        break
      case 'subagent.error':
        endLine()
        console.log(`  << subagent ${event.name} failed: ${event.error}`)
        break
      case 'step.complete':
        endLine()
        console.log(
          `  = ${truncate(event.result.summary, 400)} (${event.result.durationMs}ms, ${event.result.toolCalls.length} tool calls)`,
        )
        break
      case 'replan.decision':
        if (event.mode !== 'continue') {
          endLine()
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
        endLine()
        console.log(`[retry]   ${event.phase} attempt=${event.attempt}: ${event.error}`)
        break
      case 'budget.exceeded':
        endLine()
        console.log(
          `[budget]  ${event.kind} cap reached: ${event.tokens}/${event.cap} - finishing early`,
        )
        break
      case 'revisions.exceeded':
        endLine()
        console.log(`[budget]  max ${event.cap} replan-revisions reached - finishing early`)
        break
      case 'context.compacted':
        endLine()
        console.log(
          `[compact] ${event.scope}: ~${event.beforeTokens} -> ~${event.afterTokens} tokens`,
        )
        break
      case 'final.text-delta':
        if (streaming !== 'final') {
          endLine()
          process.stdout.write('\nassistant> ')
          streaming = 'final'
        }
        process.stdout.write(event.delta)
        break
      case 'final':
        if (streaming === 'final') {
          process.stdout.write('\n\n')
          streaming = 'none'
        } else {
          endLine()
          console.log(`\nassistant> ${event.text}\n`)
        }
        break
      case 'error':
        // A planner failure may interrupt mid-stream. Flush the partial
        // [plan] line so the next output (fallback plan or error) starts
        // cleanly, mirroring what the retry case does.
        endLine()
        console.error(`[error] (${event.phase}) ${event.error.message}`)
        break
    }
  }

  const rl = createInterface({ input, output })
  let runController: AbortController | null = null
  let inputController: AbortController | null = null

  // Approval prompts go through the REPL's readline. Parallel tool calls
  // would otherwise interleave questions, so they are asked one at a time.
  let approvalQueue: Promise<unknown> = Promise.resolve()
  const askApproval = (req: IToolApprovalRequest): Promise<ToolApprovalDecision> => {
    const ask = async (): Promise<ToolApprovalDecision> => {
      endLine()
      const answer = (
        await rl.question(
          `[approve] ${req.toolName} ${formatJson(req.input)}${req.readOnly ? ' (read-only)' : ''}\n          allow? [y]es / [n]o / [a]lways: `,
          runController ? { signal: runController.signal } : {},
        )
      )
        .trim()
        .toLowerCase()
      if (answer === 'a' || answer === 'always') {
        return { approved: true, remember: true }
      }
      if (answer === 'y' || answer === 'yes') {
        return true
      }
      return { approved: false, reason: 'denied at the prompt' }
    }
    const next = approvalQueue.then(ask, ask)
    approvalQueue = next.catch(() => {})
    return next
  }
  config.toolApproval = { ...config.toolApproval, onRequest: askApproval }

  const agent = await createAgent(config, onEvent)
  // /autopilot toggles back to the last non-autopilot mode.
  let lastAskMode: ToolApprovalMode =
    agent.getToolApprovalMode() === 'autopilot' ? 'ask-writes' : agent.getToolApprovalMode()

  const tools = agent.listTools()
  console.log(
    `[tools]   available=${tools.length}${tools.length ? `: ${tools.map((t) => t.name).join(', ')}` : ''}`,
  )
  const history: IConversationTurn[] = []

  // Use process-level SIGINT instead of rl.on('SIGINT'): the latter only fires
  // while rl.question() is actively reading. During `await agent.run(...)`
  // readline is idle, so Ctrl-C would otherwise hit Node's default handler
  // (terminate). With this listener:
  //   - Ctrl-C during a run: aborts the run via runController (an open
  //     approval question is cancelled with it).
  //   - Ctrl-C at the prompt: aborts the rl.question() via inputController,
  //     which makes the await reject with AbortError - the loop catches it
  //     and breaks cleanly. (Just calling rl.close() does NOT always reject
  //     a pending question() in node:readline/promises, which is what made
  //     Ctrl-C "hang" before this fix.)
  //   - Double Ctrl-C: hard exit. agent.close() against an unresponsive MCP
  //     transport can itself hang; the second Ctrl-C is the user's escape
  //     hatch out of the cleanup phase.
  let sigIntCount = 0
  const onSigInt = () => {
    sigIntCount++
    if (sigIntCount >= 2) {
      console.log('\n[abort] forcing exit')
      process.exit(130)
    }
    if (runController) {
      console.log('\n[abort] cancelling current run...')
      runController.abort()
      return
    }
    if (inputController) {
      inputController.abort()
      return
    }
  }
  process.on('SIGINT', onSigInt)
  // While readline is reading (the prompt, an approval question) the TTY is
  // in raw mode and Ctrl-C reaches readline instead of the process; route it
  // to the same handler (only one of the two ever fires for a keypress).
  rl.on('SIGINT', onSigInt)

  try {
    while (true) {
      let prompt: string
      inputController = new AbortController()
      try {
        prompt = (await rl.question('\nyou> ', { signal: inputController.signal })).trim()
        sigIntCount = 0
      } catch (err) {
        if ((err as { name?: string })?.name === 'AbortError') {
          // Ctrl-C at the prompt is the canonical way out of the REPL.
          break
        }
        // Any other rejection (e.g. stdin EOF) - bail out the same way.
        break
      } finally {
        inputController = null
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
            console.log(
              `  - ${t.name}${t.readOnly ? ' (read-only)' : ''}: ${truncate(t.description, 200)}`,
            )
          }
        }
        continue
      }
      if (prompt === '/status') {
        const limits = config.limits ?? {}
        const caps = [
          limits.maxInputTokens ? `in=${limits.maxInputTokens}` : '',
          limits.maxOutputTokens ? `out=${limits.maxOutputTokens}` : '',
          limits.maxReasoningTokens ? `reasoning=${limits.maxReasoningTokens}` : '',
          (limits.maxTotalTokens ?? config.maxTotalTokens)
            ? `total=${limits.maxTotalTokens ?? config.maxTotalTokens}`
            : '',
          config.maxToolCalls ? `toolCalls=${config.maxToolCalls}` : '',
        ].filter(Boolean)
        console.log(
          `[status] model=${config.model} planner=${plannerModelEff} synth=${synthModelEff}`,
        )
        console.log(
          `[status] tools=${tools.length} strategy=${config.toolSelectionStrategy ?? 'auto'} mcp=${mcpNames.join(', ') || '(none)'} historyTurns=${history.length}`,
        )
        console.log(
          `[status] thinking=${describeThinking(config.thinking)} approval=${agent.getToolApprovalMode()} limits=${caps.length ? caps.join(' ') : '(none)'}`,
        )
        console.log(
          `[status] compaction=${config.compaction?.auto === false ? 'manual' : 'auto'} window=${config.compaction?.contextWindowTokens ?? 128_000} skills=${
            agent
              .listSkills()
              .map((s) => s.name)
              .join(', ') || '(none)'
          }`,
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
      if (prompt === '/compact') {
        const r = await agent.compact({ history, force: true })
        if (r.compacted) {
          history.splice(0, history.length, ...r.history)
          console.log(`[compact] history: ~${r.beforeTokens} -> ~${r.afterTokens} tokens`)
        } else {
          console.log('[compact] nothing to compact')
        }
        continue
      }
      if (prompt === '/autopilot') {
        const current = agent.getToolApprovalMode()
        if (current === 'autopilot') {
          agent.setToolApprovalMode(lastAskMode)
        } else {
          lastAskMode = current
          agent.setToolApprovalMode('autopilot')
        }
        console.log(`[approval] mode=${agent.getToolApprovalMode()}`)
        continue
      }
      if (prompt === '/approval' || prompt.startsWith('/approval ')) {
        const mode = prompt.slice('/approval'.length).trim()
        if (!mode) {
          console.log(`[approval] mode=${agent.getToolApprovalMode()}`)
        } else if (!APPROVAL_MODES.includes(mode as ToolApprovalMode)) {
          console.log(`[approval] unknown mode "${mode}"; use ${APPROVAL_MODES.join(' | ')}`)
        } else {
          agent.setToolApprovalMode(mode as ToolApprovalMode)
          if (mode !== 'autopilot') {
            lastAskMode = mode as ToolApprovalMode
          }
          console.log(`[approval] mode=${mode}`)
        }
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

      streaming = 'none'
      runController = new AbortController()
      try {
        const result = await agent.run({
          input: prompt,
          history,
          signal: runController.signal,
        })
        sigIntCount = 0
        // The run compacted the history it was given: keep the compacted copy.
        if (result.compactedHistory) {
          history.splice(0, history.length, ...result.compactedHistory)
        }
        history.push({ role: 'user', content: prompt })
        history.push({ role: 'assistant', content: result.text })
        trimHistory(history)
        const u = result.usage
        console.log(
          `[meta]    iterations=${result.iterations} steps=${result.trace.length} tokens=${u.totalTokens} (in=${u.inputTokens} out=${u.outputTokens}${u.reasoningTokens ? ` reasoning=${u.reasoningTokens}` : ''}${u.cachedInputTokens ? ` cached=${u.cachedInputTokens}` : ''})`,
        )
      } catch (err) {
        endLine()
        if ((err as { name?: string })?.name === 'AbortError') {
          console.log('[abort] run cancelled')
          sigIntCount = 0
        } else {
          console.error('[error]', (err as Error).message)
        }
      } finally {
        runController = null
      }
    }
  } finally {
    process.off('SIGINT', onSigInt)
    rl.off('SIGINT', onSigInt)
    rl.close()
    // Library-side timeout caps both the (skipped here) wait for active runs
    // AND the MCP transport teardown, so close() can never hang the CLI.
    // The double-Ctrl-C escape hatch in onSigInt is the user's belt-and-
    // suspenders against any tighter unresponsiveness.
    await agent
      .close({ timeoutMs: 5_000 })
      .catch((err: unknown) => console.error('[cleanup] agent', err))
  }
}
