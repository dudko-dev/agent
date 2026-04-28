import { streamText } from 'ai'
import type { IAgentInternalContext } from './internal.ts'
import { SYNTHESIZER_SYSTEM, buildSynthesizerUserPrompt } from './prompts.ts'
import type { IConversationTurn, IPlan, IStepResult, IUsage } from './types.ts'
import { withRetry, withTimeout } from './utils.ts'

export const synthesizeAnswer = async (
  input: string,
  plan: IPlan,
  trace: IStepResult[],
  history: IConversationTurn[] | undefined,
  ctx: IAgentInternalContext,
  signal?: AbortSignal,
): Promise<string> => {
  const { text, usage } = await withRetry(
    () => streamOnce(input, plan, trace, history, ctx, signal),
    {
      maxRetries: ctx.config.llmMaxRetries ?? 2,
      signal,
      onRetry: (attempt, err) =>
        ctx.emit({ type: 'retry', phase: 'synthesize', attempt, error: (err as Error).message }),
    },
  )
  ctx.emit({ type: 'usage', phase: 'synthesize', usage })
  return text
}

const streamOnce = async (
  input: string,
  plan: IPlan,
  trace: IStepResult[],
  history: IConversationTurn[] | undefined,
  ctx: IAgentInternalContext,
  signal?: AbortSignal,
): Promise<{ text: string; usage: IUsage }> => {
  const result = streamText({
    model: ctx.synthesizerModel,
    system: SYNTHESIZER_SYSTEM,
    prompt: buildSynthesizerUserPrompt(input, plan, trace, history),
    abortSignal: withTimeout(signal, ctx.config.llmTimeoutMs ?? 0),
  })

  for await (const part of result.fullStream) {
    if (part.type === 'text-delta') {
      if (part.text) {
        ctx.emit({ type: 'final.text-delta', delta: part.text })
      }
    } else if (part.type === 'error') {
      const error = part.error
      throw error instanceof Error ? error : new Error(String(error))
    }
  }

  const [text, rawUsage] = await Promise.all([result.text, result.usage])
  return {
    text,
    usage: {
      inputTokens: rawUsage.inputTokens ?? 0,
      outputTokens: rawUsage.outputTokens ?? 0,
      totalTokens: rawUsage.totalTokens ?? 0,
    },
  }
}
