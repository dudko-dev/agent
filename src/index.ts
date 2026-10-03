export { createAgent } from './agent.ts'
export type { IAgent, ICloseOptions, ICompactOptions, ICompactResult } from './agent.ts'
export { getCurrentRunId, getCurrentRunSandbox } from './context.ts'
export { addUsage, normalizeUsage, redactHeaders } from './utils.ts'
export {
  beginMcpOAuth,
  createNodeOAuthProvider,
  FileOAuthStore,
  finishMcpOAuth,
  MemoryOAuthStore,
  NodeOAuthProvider,
} from './mcp-oauth.ts'
export type { INodeOAuthProviderOptions, IOAuthRequestOptions, IOAuthStore } from './mcp-oauth.ts'

// Thinking
export { mergeProviderOptions, resolveThinking } from './thinking.ts'
export type { IResolvedThinking } from './thinking.ts'
// Token limits
export { checkLimits, resolveLimits } from './limits.ts'
// Compaction
export {
  compactHistory,
  estimateTokens,
  SUMMARY_PREFIX,
  truncateToolModelOutput,
  withToolOutputLimit,
} from './compaction.ts'
export type { ICompactHistoryOptions, ICompactHistoryResult } from './compaction.ts'
// Skills
export { defineSkill, loadSkillsFromDir, parseSkillMarkdown } from './skills.ts'
// Tool approval
export {
  decideToolPermission,
  isReadOnlyTool,
  markReadOnly,
  matchToolRule,
  ToolDeniedError,
} from './approval.ts'
export type { IToolDecision, IToolDecisionInput } from './approval.ts'
export { ToolBudgetError } from './tool-wrap.ts'
// Tool search
export { searchTools } from './tool-search.ts'
export type { ISearchToolsOptions } from './tool-search.ts'
// Prompt caching
export { buildInstructions, resolvePromptCaching, withRollingBreakpoint } from './caching.ts'
// Context editing (stale tool results inside a step's tool loop)
export { createToolResultClearer } from './context-editing.ts'
export type { IClearedInfo, IToolResultClearing } from './context-editing.ts'
// Subagents
export { createSubagentTool } from './subagent.ts'
export type { ISubagentToolOptions, SubagentIsolation } from './subagent.ts'

export type {
  AgentEvent,
  AgentStage,
  BudgetKind,
  EventHandler,
  IAgentConfig,
  IAgentRunOptions,
  IAgentRunResult,
  IAgentStageOverride,
  ICompactionConfig,
  IConversationTurn,
  ILimitBreach,
  IMcpHttpServerConfig,
  IMcpServerConfig,
  IMcpStdioServerConfig,
  IPersistence,
  IRunSnapshot,
  ISkill,
  IStepStartInfo,
  IPlan,
  IPlanStep,
  IStepResult,
  IThinkingConfig,
  ITokenLimits,
  IToolApprovalConfig,
  IToolApprovalRequest,
  IToolCatalogEntry,
  IUsage,
  LogLevel,
  PromptCachingSetting,
  ProviderType,
  ReplanCause,
  ReplanTrigger,
  ThinkingLevel,
  ThinkingSetting,
  TokenLimitKind,
  ToolApprovalDecision,
  ToolApprovalMode,
  ToolPermission,
  ToolSelectionStrategy,
  UsagePhase,
} from './types.ts'
