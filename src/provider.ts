import { createAnthropic } from '@ai-sdk/anthropic'
import { createGoogleGenerativeAI } from '@ai-sdk/google'
import { createOpenAI } from '@ai-sdk/openai'
import { createOpenAICompatible } from '@ai-sdk/openai-compatible'
import type { LanguageModel } from 'ai'
import type { IAgentConfig, IAgentStageOverride, ProviderType } from './types.ts'

// Concrete, fully-resolved per-stage model parameters. Built by resolveStage
// from the top-level config + an optional override block.
export interface IResolvedStage {
  providerType: ProviderType
  baseURL?: string
  apiKey: string
  model: string
}

// Resolve a single stage (executor / planner / synthesizer) by layering an
// optional override on top of the IAgentConfig defaults, then validating
// the result.
//
// Validation: a cross-provider override (e.g. planner on Anthropic while the
// default is OpenAI) MUST come with its own apiKey. Inheriting keys across
// vendors is almost always a misconfig - the SDK would either succeed against
// the wrong endpoint with the wrong format, or fail far away from the source
// of confusion.
export const resolveStage = (
  config: IAgentConfig,
  override: IAgentStageOverride | undefined,
  // Legacy single-string shortcuts for the model only (config.plannerModel /
  // config.synthesizerModel). The override block, if present, wins.
  legacyModel: string | undefined,
  stageName: 'executor' | 'planner' | 'synthesizer',
): IResolvedStage => {
  const providerType = override?.providerType ?? config.providerType
  const apiKey = override?.apiKey ?? config.apiKey
  const baseURL = override?.baseURL ?? config.baseURL
  const model = override?.model ?? legacyModel ?? config.model

  if (override?.providerType && override.providerType !== config.providerType && !override.apiKey) {
    throw new Error(
      `${stageName}: providerType "${override.providerType}" differs from the default "${config.providerType}" - you must also set ${stageName}.apiKey (cross-provider key inheritance is unsafe)`,
    )
  }
  if (providerType === 'openai-compatible' && !baseURL) {
    throw new Error(
      `${stageName}: provider "openai-compatible" requires a baseURL (set ${stageName}.baseURL or the top-level baseURL)`,
    )
  }
  return { providerType, baseURL, apiKey, model }
}

// We deliberately do NOT override `user-agent` here: the AI SDK injects its
// own descriptive UA (`ai-sdk/openai/x.y.z ...`) which providers use for
// analytics and rate-limit policies. clientName is propagated through MCP
// instead.
//
// Provider-specific notes:
// - `google` uses Gemini's native API. PREFER THIS for Gemini models: the
//   OpenAI-compatible Gemini endpoint silently drops `responseFormat` (breaks
//   structured outputs) and omits `tool_calls[].index` in stream chunks (breaks
//   the SDK's stream validator).
// - `openai-compatible` is for self-hosted OpenAI-spec servers (vLLM, ollama,
//   etc.) - works with anything that follows the spec strictly.
export const buildModelFromStage = (clientName: string, stage: IResolvedStage): LanguageModel => {
  switch (stage.providerType) {
    case 'openai': {
      const provider = createOpenAI({
        baseURL: stage.baseURL || undefined,
        apiKey: stage.apiKey,
      })
      return provider(stage.model)
    }
    case 'anthropic': {
      const provider = createAnthropic({
        baseURL: stage.baseURL || undefined,
        apiKey: stage.apiKey,
      })
      return provider(stage.model)
    }
    case 'openai-compatible': {
      if (!stage.baseURL) {
        throw new Error('openai-compatible provider requires baseURL')
      }
      const provider = createOpenAICompatible({
        name: clientName,
        baseURL: stage.baseURL,
        apiKey: stage.apiKey,
      })
      return provider(stage.model)
    }
    case 'google': {
      const provider = createGoogleGenerativeAI({
        baseURL: stage.baseURL || undefined,
        apiKey: stage.apiKey,
      })
      return provider(stage.model)
    }
  }
}

// Backward-compat shim. Kept for tests that drove buildModel directly with a
// model id. New code goes through resolveStage + buildModelFromStage.
export const buildModel = (config: IAgentConfig, modelId: string): LanguageModel =>
  buildModelFromStage(config.clientName, {
    providerType: config.providerType,
    baseURL: config.baseURL,
    apiKey: config.apiKey,
    model: modelId,
  })
