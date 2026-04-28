import type { LanguageModel, ToolSet } from 'ai'
import type { EventHandler, IAgentConfig } from './types.ts'

export interface IAgentInternalContext {
  config: IAgentConfig
  executorModel: LanguageModel
  plannerModel: LanguageModel
  synthesizerModel: LanguageModel
  tools: ToolSet
  toolCatalog: { name: string; description: string }[]
  emit: EventHandler
}
