import type { LanguageModel, ToolSet } from 'ai'
import type { IApprovalController } from './approval.ts'
import type { EventHandler, IAgentConfig, ISkill, IToolCatalogEntry, IUsage } from './types.ts'

// The effective (resolved) tool selection strategy of a run.
export type EffectiveToolStrategy = 'all' | 'plan-narrowed' | 'search'

// Mutable state of ONE run, shared between the runner, the stages and the
// tool wrappers (reached from inside a tool through the run context).
export interface IRunState {
  // Live usage accumulator of the run (the object the result returns).
  usage: IUsage
  // Tool calls made so far (maxToolCalls).
  toolCalls: number
  strategy: EffectiveToolStrategy
  // Tools find_tools activated, oldest first (search strategy).
  discovered: string[]
  // Tools active in the executor call in flight (search strategy); find_tools
  // adds to it so the next LLM step sees the new tools.
  stepActive?: Set<string>
  // Skill names active for the rest of the run, in activation order.
  activeSkills: string[]
  // Running summary of trace[0, traceSummaryUpTo).
  traceSummary?: string
  traceSummaryUpTo: number
}

export interface IAgentInternalContext {
  config: IAgentConfig
  executorModel: LanguageModel
  plannerModel: LanguageModel
  synthesizerModel: LanguageModel
  // Host + MCP tools, already wrapped (approval gate, tool-call budget,
  // model-visible output cap). Mutated in place on refresh / reconnect.
  tools: ToolSet
  toolCatalog: IToolCatalogEntry[]
  emit: EventHandler
  // Built-in skill tools (load_skill / read_skill_file), when skills exist.
  builtinTools?: ToolSet
  // The find_tools built-in, when the search strategy is possible.
  findTools?: ToolSet
  skills?: ISkill[]
  approval?: IApprovalController
  // Per-run state; set by the runner on its per-run copy of the context.
  run?: IRunState
}
