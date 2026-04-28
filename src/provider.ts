import { createAnthropic } from '@ai-sdk/anthropic'
import { createGoogleGenerativeAI } from '@ai-sdk/google'
import { createOpenAI } from '@ai-sdk/openai'
import { createOpenAICompatible } from '@ai-sdk/openai-compatible'
import type { LanguageModel } from 'ai'
import type { IAgentConfig } from './types.ts'

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
export const buildModel = (config: IAgentConfig, modelId: string): LanguageModel => {
  switch (config.providerType) {
    case 'openai': {
      const provider = createOpenAI({
        baseURL: config.baseURL || undefined,
        apiKey: config.apiKey,
      })
      return provider(modelId)
    }
    case 'anthropic': {
      const provider = createAnthropic({
        baseURL: config.baseURL || undefined,
        apiKey: config.apiKey,
      })
      return provider(modelId)
    }
    case 'openai-compatible': {
      if (!config.baseURL) {
        throw new Error('openai-compatible provider requires baseURL')
      }
      const provider = createOpenAICompatible({
        name: config.clientName,
        baseURL: config.baseURL,
        apiKey: config.apiKey,
      })
      return provider(modelId)
    }
    case 'google': {
      const provider = createGoogleGenerativeAI({
        baseURL: config.baseURL || undefined,
        apiKey: config.apiKey,
      })
      return provider(modelId)
    }
  }
}
