import { parseArgs } from 'node:util'

export interface ICliArgs {
  envFile?: string
  help: boolean
  // Optional one-shot overrides for the most common env vars. They are applied
  // to process.env before loadConfig() runs, so flags win over an .env file
  // and over the ambient process env.
  overrides: Record<string, string>
}

export const HELP = `Usage: dd-agent [options]

Options:
  --env-file=<path>             Load env vars from a dotenv file before starting
  --provider=<type>             AGENT_PROVIDER_TYPE (openai|anthropic|google|openai-compatible)
  --model=<id>                  AGENT_MODEL
  --planner-model=<id>          AGENT_PLANNER_MODEL
  --synthesizer-model=<id>      AGENT_SYNTHESIZER_MODEL
  --base-url=<url>              AGENT_BASE_URL
  --log-level=<level>           AGENT_LOG_LEVEL (none|error|warn|info|debug)
  --max-iterations=<n>          AGENT_MAX_ITERATIONS
  --max-steps-per-task=<n>      AGENT_MAX_STEPS_PER_TASK
  --tool-strategy=<v>           AGENT_TOOL_SELECTION_STRATEGY (all|plan-narrowed)
  -h, --help                    Show this help

API keys are still read from env (AGENT_API_KEY etc.) - we deliberately do
not accept them as flags so they don't end up in shell history.

Required env vars (set directly or via --env-file):
  AGENT_PROVIDER_TYPE   one of: openai | anthropic | openai-compatible | google
  AGENT_API_KEY         provider API key
  AGENT_MODEL           model id
  MCP_SERVERS           JSON: { "<name>": { "url": "...", "headers"?: {...} } | { "command": "...", "args"?: [], "env"?: {} } }

Commands inside the REPL:
  /status, /tools, /history, /reset, /reconnect, /exit
`

const FLAG_TO_ENV: Record<string, string> = {
  provider: 'AGENT_PROVIDER_TYPE',
  model: 'AGENT_MODEL',
  'planner-model': 'AGENT_PLANNER_MODEL',
  'synthesizer-model': 'AGENT_SYNTHESIZER_MODEL',
  'base-url': 'AGENT_BASE_URL',
  'log-level': 'AGENT_LOG_LEVEL',
  'max-iterations': 'AGENT_MAX_ITERATIONS',
  'max-steps-per-task': 'AGENT_MAX_STEPS_PER_TASK',
  'tool-strategy': 'AGENT_TOOL_SELECTION_STRATEGY',
}

export const parseCliArgs = (argv: string[]): ICliArgs => {
  const { values } = parseArgs({
    args: argv,
    options: {
      'env-file': { type: 'string' },
      help: { type: 'boolean', short: 'h' },
      provider: { type: 'string' },
      model: { type: 'string' },
      'planner-model': { type: 'string' },
      'synthesizer-model': { type: 'string' },
      'base-url': { type: 'string' },
      'log-level': { type: 'string' },
      'max-iterations': { type: 'string' },
      'max-steps-per-task': { type: 'string' },
      'tool-strategy': { type: 'string' },
    },
    strict: true,
    allowPositionals: false,
  })
  const overrides: Record<string, string> = {}
  // values is a heterogeneous record from parseArgs; cast to a string-keyed
  // string|undefined map for the lookup. The schema above only declares
  // string options (besides --help), so this is sound at runtime.
  const lookup = values as Record<string, string | undefined>
  for (const [flag, envVar] of Object.entries(FLAG_TO_ENV)) {
    const v = lookup[flag]
    if (typeof v === 'string' && v.length > 0) {
      overrides[envVar] = v
    }
  }
  return {
    envFile: values['env-file'],
    help: Boolean(values.help),
    overrides,
  }
}
