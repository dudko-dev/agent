import { SpanStatusCode, trace, type Span, type Tracer } from '@opentelemetry/api'
import packageJson from '../package.json' with { type: 'json' }

const TRACER_NAME = '@dudko.dev/agent'
const VERSION = (packageJson as { version: string }).version

// Lazily resolved on first call. The OTel API package returns a no-op tracer
// when no SDK has registered a TracerProvider, so this is always safe to
// invoke even without OTel infra wired up.
let cached: Tracer | undefined
const tracer = (): Tracer => {
  if (!cached) {
    cached = trace.getTracer(TRACER_NAME, VERSION)
  }
  return cached
}

// Common span attribute keys we set across the agent. Defined as constants
// so consumers can build dashboards/queries against stable names. Only keys
// that are actually written somewhere in src/ are listed here - dead keys
// give a false impression that a dashboard built on them would receive data.
export const ATTR = {
  RUN_ID: 'agent.run_id',
  PHASE: 'agent.phase',
  PROVIDER: 'agent.provider',
  MODEL: 'agent.model',
  STEP_ID: 'agent.step.id',
  STEP_BLOCKED: 'agent.step.blocked',
  REPLAN_MODE: 'agent.replan.mode',
  TOOL_NAME: 'agent.tool.name',
  TOOL_OK: 'agent.tool.ok',
  USAGE_INPUT_TOKENS: 'agent.usage.input_tokens',
  USAGE_OUTPUT_TOKENS: 'agent.usage.output_tokens',
  USAGE_TOTAL_TOKENS: 'agent.usage.total_tokens',
  ITERATIONS: 'agent.iterations',
  TOOL_COUNT: 'agent.tool_count',
} as const

// Run `fn` inside an active span. The span is closed automatically; on a
// thrown error we record it and mark the span ERROR before rethrowing. Any
// attributes the caller wants to attach should be set on the span passed
// into fn (we pass it as the second arg).
//
// Designed to be cheap when no SDK is installed: getTracer() returns a no-op
// tracer, and startActiveSpan calls fn synchronously with a no-op span.
export const withSpan = async <T>(
  name: string,
  attrs: Record<string, string | number | boolean | undefined>,
  fn: (span: Span) => Promise<T>,
): Promise<T> => {
  return tracer().startActiveSpan(name, async (span) => {
    for (const [k, v] of Object.entries(attrs)) {
      if (v !== undefined) {
        span.setAttribute(k, v)
      }
    }
    try {
      const result = await fn(span)
      span.end()
      return result
    } catch (err) {
      const e = err instanceof Error ? err : new Error(String(err))
      span.recordException(e)
      span.setStatus({ code: SpanStatusCode.ERROR, message: e.message })
      span.end()
      throw err
    }
  })
}
