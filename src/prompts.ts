import type { IConversationTurn, IPlan, IPlanStep, IStepResult } from './types.ts'

const HISTORY_TURN_LIMIT = 8
const HISTORY_CONTENT_LIMIT = 1500

export const renderHistory = (history: IConversationTurn[] | undefined): string => {
  if (!history?.length) {
    return '(no prior conversation)'
  }
  const tail = history.slice(-HISTORY_TURN_LIMIT)
  const skipped = history.length - tail.length
  const lines: string[] = []
  if (skipped > 0) {
    lines.push(`(${skipped} earlier turns omitted)`)
  }
  for (const t of tail) {
    const content =
      t.content.length > HISTORY_CONTENT_LIMIT
        ? `${t.content.slice(0, HISTORY_CONTENT_LIMIT)}... [truncated]`
        : t.content
    lines.push(`${t.role}: ${content}`)
  }
  return lines.join('\n')
}

const CATALOG_BUDGETS = {
  full: { tools: 80, descChars: 240 },
  compact: { tools: 200, descChars: 80 },
} as const

export type CatalogMode = keyof typeof CATALOG_BUDGETS

export const renderToolCatalog = (
  catalog: { name: string; description: string }[],
  mode: CatalogMode = 'full',
): string => {
  if (catalog.length === 0) {
    return '(no tools available)'
  }
  const { tools: toolLimit, descChars } = CATALOG_BUDGETS[mode]
  const sliced = catalog.slice(0, toolLimit)
  const rest = catalog.length - sliced.length
  const lines = sliced.map((t) => {
    const desc = (t.description || '').replace(/\s+/g, ' ').trim().slice(0, descChars)
    return `- ${t.name}: ${desc}`
  })
  if (rest > 0) {
    lines.push(`... and ${rest} more tools`)
  }
  return lines.join('\n')
}

const TOOL_OUTPUT_BUDGET = 1500

const truncateOutput = (output: unknown): string => {
  let s: string
  try {
    s = typeof output === 'string' ? output : JSON.stringify(output)
  } catch {
    s = String(output)
  }
  return s.length > TOOL_OUTPUT_BUDGET
    ? `${s.slice(0, TOOL_OUTPUT_BUDGET)}... [truncated, ${s.length - TOOL_OUTPUT_BUDGET} chars]`
    : s
}

const renderTraceEntry = (r: IStepResult, idx: number): string => {
  const calls = r.toolCalls.length
    ? r.toolCalls
        .map((c) => `    - ${c.name} ${c.ok ? 'ok' : 'fail'}: ${truncateOutput(c.output)}`)
        .join('\n')
    : '    (no tool calls)'
  return [
    `Step ${idx + 1}: ${r.step.description}`,
    `  Result: ${r.summary}`,
    `  Tool calls:`,
    calls,
  ].join('\n')
}

export const renderTrace = (trace: IStepResult[]): string => {
  if (trace.length === 0) {
    return '(no steps executed yet)'
  }
  return trace.map(renderTraceEntry).join('\n')
}

export const renderPlan = (plan: IPlan): string =>
  [
    `Plan thought: ${plan.thought}`,
    'Steps:',
    ...plan.steps.map(
      (s, i) =>
        `  ${i + 1}. [${s.id}] ${s.description}\n     expected: ${s.expectedOutcome}` +
        (s.suggestedTools?.length ? `\n     suggested tools: ${s.suggestedTools.join(', ')}` : ''),
    ),
  ].join('\n')

export const PLANNER_SYSTEM_BASE = `You are the Planner of a multi-step agent system.

Your only job is to decompose the user's request into a short ordered list of concrete actionable steps that a tool-using Executor can perform one at a time.

Rules:
1. Produce 1-5 steps for typical requests (hard cap is 8). Prefer FEWER, larger steps over many micro-steps. If the task is trivial and needs no tools, output a single step "Answer the user directly".
2. Each step must be self-contained, action-oriented, and verifiable. State what should be done and what the expected outcome is.
3. If a step needs a tool, suggest tool name(s) ONLY from the provided available-tools list. NEVER fabricate tool names.
4. If the request asks for information that is likely retrievable via the available tools, plan to use them. If no tool fits, plan to answer from general knowledge.
5. The last step must produce the deliverable for the user (do not append a separate "summarize" step - the system synthesizes the final answer).
6. Output strict JSON matching the requested schema. No prose outside JSON.`

const PLANNER_NARROWED_ADDENDUM = `

ADDITIONAL RULE (tool-narrowed mode):
The agent narrows the active tool set per-step using suggestedTools. You MUST set suggestedTools to the EXACT tool names the executor will use for that step. If a step is reasoning-only and needs no tools, leave suggestedTools empty. Missing or wrong suggestedTools will leave the executor without the tools it needs.`

export const buildPlannerSystem = (mode: CatalogMode): string =>
  mode === 'compact' ? PLANNER_SYSTEM_BASE + PLANNER_NARROWED_ADDENDUM : PLANNER_SYSTEM_BASE

export const buildPlannerUserPrompt = (
  input: string,
  toolCatalog: { name: string; description: string }[],
  history?: IConversationTurn[],
  catalogMode: CatalogMode = 'full',
): string =>
  [
    history?.length ? `Conversation history:\n${renderHistory(history)}\n` : '',
    `User request:\n${input}`,
    '',
    `Available tools:\n${renderToolCatalog(toolCatalog, catalogMode)}`,
    '',
    'Produce the plan now.',
  ]
    .filter(Boolean)
    .join('\n')

export const EXECUTOR_SYSTEM = `You are the Executor of a multi-step agent system. You receive ONE step at a time and you must accomplish only that step.

Rules:
1. Stay focused on the CURRENT step. Do not jump ahead, do not redo finished steps.
2. Use the available tools when they help. Call them with valid arguments. Read prior step results in the trace before re-fetching the same data.
3. When the step is complete, write a short concrete "step result" describing what you found / did. Include identifiers, names, or key data the next step might need.
4. If the step is impossible with the available tools, or if you are otherwise blocked, explain the blocker briefly and end your reply with the literal token [BLOCKER] on its own line. The system uses this token (language-independent) to invoke the Replanner. Do not fabricate data.
5. Be concise. Do not narrate your reasoning at length - the Replanner reads only your final summary.`

export const buildExecutorUserPrompt = (
  input: string,
  plan: IPlan,
  step: IPlanStep,
  trace: IStepResult[],
  history?: IConversationTurn[],
): string =>
  [
    history?.length ? `Conversation history:\n${renderHistory(history)}\n` : '',
    `Original user request:\n${input}`,
    '',
    `Overall plan:\n${renderPlan(plan)}`,
    '',
    `Trace so far:\n${renderTrace(trace)}`,
    '',
    `CURRENT STEP to execute (id=${step.id}): ${step.description}`,
    `Expected outcome: ${step.expectedOutcome}`,
    step.suggestedTools?.length ? `Suggested tools: ${step.suggestedTools.join(', ')}` : '',
    '',
    'Execute this step now. Reply with a concise summary of what you found / did - the system uses your full reply as the step result.',
  ]
    .filter(Boolean)
    .join('\n')

export const REPLANNER_SYSTEM = `You are the Replanner of a multi-step agent system. After each Executor step you decide what should happen next.

You have three options:
- "continue": the next planned step is still appropriate.
- "revise": the plan is wrong or incomplete given what we now know - produce a NEW plan covering only the REMAINING work (do not include already-completed steps). The new plan must follow the same rules as the original Planner.
- "finish": we already have enough information to answer the user. The system will then synthesize the final answer from the trace.

Rules:
1. Prefer "continue" when the original plan still applies. Revise only when needed.
2. Prefer "finish" as soon as the user's request is satisfied - do not run unnecessary extra steps.
3. When revising, the new plan must NOT repeat already-completed work; it covers only what is still needed.
4. Output strict JSON matching the schema. No prose outside JSON.`

export const buildReplannerUserPrompt = (
  input: string,
  plan: IPlan,
  trace: IStepResult[],
  nextStep: IPlanStep | null,
  toolCatalog: { name: string; description: string }[],
  catalogMode: CatalogMode = 'full',
): string =>
  [
    `Original user request:\n${input}`,
    '',
    `Current plan:\n${renderPlan(plan)}`,
    '',
    `Completed steps:\n${renderTrace(trace)}`,
    '',
    nextStep
      ? `Next planned step: [${nextStep.id}] ${nextStep.description}`
      : 'There is no next step in the current plan.',
    '',
    `Available tools (for revise option):\n${renderToolCatalog(toolCatalog, catalogMode)}`,
    '',
    'Decide now: continue, revise, or finish.',
  ].join('\n')

export const SYNTHESIZER_SYSTEM = `You are the Synthesizer. Produce the final answer for the user from the agent's plan and execution trace.

Rules:
1. Answer the user directly and concisely. Do NOT mention "steps", "plans", or internal mechanics unless the user explicitly asked for them.
2. Use facts from the trace verbatim when accuracy matters (names, IDs, numbers, quotes).
3. If the trace shows the request could not be completed, say so plainly and explain what blocked it.
4. Use the user's language.`

export const buildSynthesizerUserPrompt = (
  input: string,
  plan: IPlan,
  trace: IStepResult[],
  history?: IConversationTurn[],
): string =>
  [
    history?.length ? `Conversation history:\n${renderHistory(history)}\n` : '',
    `User request:\n${input}`,
    '',
    `Plan that was executed:\n${renderPlan(plan)}`,
    '',
    `Execution trace:\n${renderTrace(trace)}`,
    '',
    'Write the final answer for the user now.',
  ]
    .filter(Boolean)
    .join('\n')
