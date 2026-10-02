import { isSummaryTurn } from './compaction.ts'
import { renderActiveSkills, renderSkillsIndex } from './skills.ts'
import { FIND_TOOLS_TOOL, renderSearchCatalog } from './tool-search.ts'
import type {
  IConversationTurn,
  IPlan,
  IPlanStep,
  ISkill,
  IStepResult,
  IToolCatalogEntry,
} from './types.ts'

// ── Layout ───────────────────────────────────────────────────────────────
// Every stage splits its prompt in two:
//   SYSTEM - run-stable content only: role instructions, domain context,
//            skills index, tool catalogue (where the stage shows one) and the
//            active skills. Identical across the calls of a stage within a
//            run, so provider prefix caches (OpenAI / Gemini implicit,
//            Anthropic via an explicit breakpoint) hit.
//   USER   - everything dynamic: history, request, plan, trace, state.

const HISTORY_TURN_LIMIT = 8
const HISTORY_CONTENT_LIMIT = 1500
// A compaction summary carries more than an ordinary turn; give it room.
const HISTORY_SUMMARY_LIMIT = 6000

export const renderHistory = (history: IConversationTurn[] | undefined): string => {
  if (!history?.length) {
    return '(no prior conversation)'
  }
  // A leading compaction summary is always kept (it stands for every turn
  // before it), and the 8-turn window applies to the rest.
  const summary = isSummaryTurn(history[0]) ? history[0] : undefined
  const rest = summary ? history.slice(1) : history
  const tail = rest.slice(-HISTORY_TURN_LIMIT)
  const skipped = rest.length - tail.length
  const lines: string[] = []
  if (summary) {
    const content =
      summary.content.length > HISTORY_SUMMARY_LIMIT
        ? `${summary.content.slice(0, HISTORY_SUMMARY_LIMIT)}... [truncated]`
        : summary.content
    lines.push(`${summary.role}: ${content}`)
  }
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

// How a stage renders the catalogue: the two classic budgets, or the grouped
// short form of the 'search' strategy.
export type PromptCatalogMode = CatalogMode | 'search'

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

export const renderCatalogFor = (catalog: IToolCatalogEntry[], mode: PromptCatalogMode): string =>
  mode === 'search' ? renderSearchCatalog(catalog) : renderToolCatalog(catalog, mode)

const TOOL_OUTPUT_BUDGET = 1500

const truncateOutput = (output: unknown): string => {
  let s: string
  try {
    s = typeof output === 'string' ? output : JSON.stringify(output)
  } catch {
    s = String(output)
  }
  if (s === undefined) {
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

// Render steps whose first element sits at `offset` in the full trace.
export const renderTraceSteps = (steps: IStepResult[], offset = 0): string =>
  steps.map((r, i) => renderTraceEntry(r, offset + i)).join('\n')

// A compacted view of the trace: steps [0, upTo) are represented by a
// running summary, the rest verbatim.
export interface ITraceView {
  summary?: string
  upTo: number
}

export const renderTrace = (trace: IStepResult[], view?: ITraceView): string => {
  if (trace.length === 0) {
    return '(no steps executed yet)'
  }
  const from = view?.summary ? Math.min(Math.max(view.upTo, 0), trace.length) : 0
  if (from === 0) {
    return renderTraceSteps(trace)
  }
  const lines = [`Summary of earlier steps (1-${from}): ${view!.summary}`]
  if (from < trace.length) {
    lines.push(renderTraceSteps(trace.slice(from), from))
  }
  return lines.join('\n')
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

// Append the user-supplied domain context to a system prompt. Applied
// uniformly to all four stages (planner, executor, replanner, synthesizer)
// so e.g. "answer in Russian" or persona instructions reach the user-facing
// synthesizer too, not just planner+executor.
export const withDomainContext = (base: string, systemPrompt: string | undefined): string =>
  systemPrompt ? `${base}\n\nDomain context:\n${systemPrompt}` : base

export const DEFAULT_PLAN_STEP_CAP = 8

const plannerBase = (
  maxSteps: number,
): string => `You are the Planner of an autonomous multi-step agent system.

Your only job is to decompose the user's request into a short ordered list of concrete, actionable steps that a tool-using Executor can carry out one at a time, on its own, without asking the user anything.

Rules:
1. Produce 1-5 steps for typical requests (hard cap is ${maxSteps}). Prefer FEWER, larger steps over many micro-steps.
2. Each step must be self-contained, action-oriented, and verifiable. State what should be done and what the expected outcome is.
3. Plan tool use whenever the available tools can obtain, check or act on what the request needs. A question that needs data the tools can retrieve IS actionable: plan the lookups, never answer it from memory. Only when no tool is relevant (greetings, thanks, small talk, or a question fully answerable from the conversation or general knowledge) output a single step "Answer the user directly".
4. If a step needs a tool, suggest tool name(s) ONLY from the provided available-tools list. NEVER fabricate tool names.
5. Never plan a step that asks the user for clarification, confirmation or permission - the agent runs autonomously and the host handles tool consent. If the request is ambiguous, pick the most reasonable interpretation and state the assumption in the step description.
6. The last step must produce the deliverable for the user (do not append a separate "summarize" step - the system synthesizes the final answer).
7. Output strict JSON matching the requested schema. No prose outside JSON.`

export const PLANNER_SYSTEM_BASE = plannerBase(DEFAULT_PLAN_STEP_CAP)

const PLANNER_NARROWED_ADDENDUM = `

ADDITIONAL RULE (tool-narrowed mode):
The agent narrows the active tool set per-step using suggestedTools. You MUST set suggestedTools to the EXACT tool names the executor will use for that step. If a step is reasoning-only and needs no tools, leave suggestedTools empty. Missing or wrong suggestedTools will leave the executor without the tools it needs.`

const PLANNER_SEARCH_ADDENDUM = `

ADDITIONAL RULE (tool-search mode):
The tool catalogue is large; the list below may be abridged. suggestedTools are optional hints: name tools you are sure fit the step, the executor loads them up front and can discover any other tool itself with ${FIND_TOOLS_TOOL}. Never invent names.`

const PLANNER_SKILLS_ADDENDUM = `

SKILL SELECTION:
Skills are packaged instructions for specific kinds of work. Set "skills" to the names of the skills from the SKILLS list below that apply to this request (leave it empty when none does). Their instructions are given to the executor.`

export const buildPlannerSystem = (
  mode: PromptCatalogMode,
  maxSteps = DEFAULT_PLAN_STEP_CAP,
): string =>
  plannerBase(maxSteps) +
  (mode === 'compact'
    ? PLANNER_NARROWED_ADDENDUM
    : mode === 'search'
      ? PLANNER_SEARCH_ADDENDUM
      : '')

export interface ISystemParts {
  // config.systemPrompt
  domain?: string
  skills?: ISkill[]
  activeSkills?: string[]
}

const skillsIndexSection = (skills: ISkill[] | undefined): string =>
  skills?.length ? `\n\nSKILLS:\n${renderSkillsIndex(skills)}` : ''

const activeSkillsSection = (
  skills: ISkill[] | undefined,
  active: string[] | undefined,
): string => {
  if (!skills?.length || !active?.length) {
    return ''
  }
  const text = renderActiveSkills(skills, active)
  return text ? `\n\nACTIVE SKILLS (follow these instructions where they apply):\n\n${text}` : ''
}

export const composePlannerSystem = (
  parts: ISystemParts & {
    mode: PromptCatalogMode
    catalog: IToolCatalogEntry[]
    maxSteps?: number
  },
): string =>
  withDomainContext(
    buildPlannerSystem(parts.mode, parts.maxSteps) +
      (parts.skills?.length ? PLANNER_SKILLS_ADDENDUM : ''),
    parts.domain,
  ) +
  skillsIndexSection(parts.skills) +
  `\n\nAvailable tools:\n${renderCatalogFor(parts.catalog, parts.mode)}`

export const buildPlannerUserPrompt = (input: string, history?: IConversationTurn[]): string =>
  [
    history?.length ? `Conversation history:\n${renderHistory(history)}\n` : '',
    `User request:\n${input}`,
    '',
    'Produce the plan now.',
  ]
    .filter(Boolean)
    .join('\n')

export const EXECUTOR_SYSTEM = `You are the Executor of an autonomous multi-step agent system. You receive ONE step at a time and you must accomplish only that step.

Rules:
1. Stay focused on the CURRENT step. Do not jump ahead, do not redo finished steps. Read prior step results in the trace before re-fetching the same data.
2. Act on your own. Look things up with the available tools instead of guessing. Never ask the user questions or for confirmation - nobody answers mid-run, and tool consent is handled by the host: just call the tool you need.
3. When details are missing, choose sensible defaults and state the assumptions you made in the step result.
4. Call tools with valid arguments. If a call fails, fix the arguments or try another tool before giving up. If a tool call is denied, do not retry it; continue without it.
5. When the step is complete, write a short concrete "step result" describing what you found / did. Include identifiers, names, or key data the next step might need. Do not fabricate data.
6. Only when the step is truly impossible (missing credentials or permissions, a denied tool, data that does not exist or cannot be reached), explain the blocker briefly and end your reply with the literal token [BLOCKER] on its own line. The system uses this token (language-independent) to invoke the Replanner.
7. Be concise. Do not narrate your reasoning at length - the Replanner reads only your final summary.`

const EXECUTOR_SEARCH_NOTE = `

TOOLS:
Only part of the tool catalogue is loaded. When you need a capability that is not among your tools, call ${FIND_TOOLS_TOOL} with a few keywords; the matching tools become callable from your next step on.`

const EXECUTOR_SKILLS_NOTE = `

SKILLS:
Packaged instructions for specific kinds of work. When one of these applies to the current step and is not active yet, call load_skill with its name before doing the work; read_skill_file reads files it bundles.`

export const composeExecutorSystem = (
  parts: ISystemParts & { searchMode?: boolean; toolCount?: number },
): string =>
  withDomainContext(EXECUTOR_SYSTEM, parts.domain) +
  (parts.skills?.length ? `${EXECUTOR_SKILLS_NOTE}\n${renderSkillsIndex(parts.skills)}` : '') +
  (parts.searchMode
    ? `${EXECUTOR_SEARCH_NOTE}${parts.toolCount ? ` The catalogue has ${parts.toolCount} tools.` : ''}`
    : '') +
  activeSkillsSection(parts.skills, parts.activeSkills)

export const buildExecutorUserPrompt = (
  input: string,
  plan: IPlan,
  step: IPlanStep,
  trace: IStepResult[],
  history?: IConversationTurn[],
  view?: ITraceView,
): string =>
  [
    history?.length ? `Conversation history:\n${renderHistory(history)}\n` : '',
    `Original user request:\n${input}`,
    '',
    `Overall plan:\n${renderPlan(plan)}`,
    '',
    `Trace so far:\n${renderTrace(trace, view)}`,
    '',
    `CURRENT STEP to execute (id=${step.id}): ${step.description}`,
    `Expected outcome: ${step.expectedOutcome}`,
    step.suggestedTools?.length ? `Suggested tools: ${step.suggestedTools.join(', ')}` : '',
    '',
    'Execute this step now. Reply with a concise summary of what you found / did - the system uses your full reply as the step result.',
  ]
    .filter(Boolean)
    .join('\n')

export const REPLANNER_SYSTEM = `You are the Replanner of an autonomous multi-step agent system. After an Executor step you decide what should happen next.

You have three options:
- "continue": the next planned step is still appropriate.
- "revise": the plan is wrong or incomplete given what we now know - produce a NEW plan covering only the REMAINING work (do not include already-completed steps). The new plan must follow the same rules as the original Planner.
- "finish": we already have enough information to answer the user, or nothing more can be done. The system will then synthesize the final answer from the trace.

Rules:
1. Prefer "continue" when the original plan still applies. Revise only when needed.
2. Prefer "finish" as soon as the user's request is satisfied - do not run unnecessary extra steps.
3. When a step failed or was blocked, prefer revising around the failure (another tool, other arguments, another source, a reasonable assumption) over finishing with nothing. Finish only when no workable alternative remains.
4. Never revise into a step that asks the user for input, clarification or permission - the agent runs autonomously.
5. When revising, the new plan must NOT repeat already-completed work; it covers only what is still needed.
6. Output strict JSON matching the schema. No prose outside JSON.`

export const composeReplannerSystem = (
  parts: ISystemParts & { mode: PromptCatalogMode; catalog: IToolCatalogEntry[] },
): string =>
  withDomainContext(REPLANNER_SYSTEM, parts.domain) +
  `\n\nAvailable tools (for the revise option):\n${renderCatalogFor(parts.catalog, parts.mode)}` +
  activeSkillsSection(parts.skills, parts.activeSkills)

export const buildReplannerUserPrompt = (
  input: string,
  plan: IPlan,
  trace: IStepResult[],
  nextStep: IPlanStep | null,
  view?: ITraceView,
): string =>
  [
    `Original user request:\n${input}`,
    '',
    `Current plan:\n${renderPlan(plan)}`,
    '',
    `Completed steps:\n${renderTrace(trace, view)}`,
    '',
    nextStep
      ? `Next planned step: [${nextStep.id}] ${nextStep.description}`
      : 'There is no next step in the current plan.',
    '',
    'Decide now: continue, revise, or finish.',
  ].join('\n')

export const SYNTHESIZER_SYSTEM = `You are the Synthesizer. Produce the final answer for the user from the agent's plan and execution trace.

Rules:
1. Answer the user directly and concisely: report what was done and what was found. Do NOT mention "steps", "plans", or internal mechanics unless the user explicitly asked for them.
2. Use facts from the trace verbatim when accuracy matters (names, IDs, numbers, quotes). Never invent results the trace does not contain.
3. Mention the assumptions the agent made, briefly.
4. If the trace shows the request (or part of it) could not be completed, say so plainly and explain what blocked it.
5. Do not end with questions or offers unless the request genuinely cannot be completed without input from the user.
6. Use the user's language.`

export const composeSynthesizerSystem = (parts: ISystemParts): string =>
  withDomainContext(SYNTHESIZER_SYSTEM, parts.domain) +
  activeSkillsSection(parts.skills, parts.activeSkills)

export const buildSynthesizerUserPrompt = (
  input: string,
  plan: IPlan,
  trace: IStepResult[],
  history?: IConversationTurn[],
  view?: ITraceView,
): string =>
  [
    history?.length ? `Conversation history:\n${renderHistory(history)}\n` : '',
    `User request:\n${input}`,
    '',
    `Plan that was executed:\n${renderPlan(plan)}`,
    '',
    `Execution trace:\n${renderTrace(trace, view)}`,
    '',
    'Write the final answer for the user now.',
  ]
    .filter(Boolean)
    .join('\n')
