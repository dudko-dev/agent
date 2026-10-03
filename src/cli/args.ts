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
  --provider=<type>             AGENT_PROVIDER_TYPE (see "Required env vars" below for the full list)
  --model=<id>                  AGENT_MODEL
  --planner-model=<id>          AGENT_PLANNER_MODEL
  --synthesizer-model=<id>      AGENT_SYNTHESIZER_MODEL
  --base-url=<url>              AGENT_BASE_URL
  --log-level=<level>           AGENT_LOG_LEVEL (none|error|warn|info|debug)
  --max-iterations=<n>          AGENT_MAX_ITERATIONS
  --max-steps-per-task=<n>      AGENT_MAX_STEPS_PER_TASK
  --tool-strategy=<v>           AGENT_TOOL_SELECTION_STRATEGY (auto|all|plan-narrowed|search)
  -h, --help                    Show this help

API keys are still read from env (AGENT_API_KEY etc.) - we deliberately do
not accept them as flags so they don't end up in shell history.

Required env vars (set directly or via --env-file):
  AGENT_PROVIDER_TYPE   openai | anthropic | google | openai-compatible | xai | azure |
                        amazon-bedrock | google-vertex | deepseek | gateway | cloudflare
  AGENT_API_KEY         provider API key
  AGENT_MODEL           model id
  MCP_SERVERS           JSON: { "<name>": { "url": "...", "headers"?: {...} } | { "command": "...", "args"?: [], "env"?: {} } }

Optional env vars (see env.example for the full list):
  AGENT_THINKING              off | minimal | low | medium | high | xhigh | <budget tokens>
  AGENT_MAX_INPUT_TOKENS      per-run caps; crossing one jumps to the final answer
  AGENT_MAX_OUTPUT_TOKENS
  AGENT_MAX_REASONING_TOKENS
  AGENT_MAX_TOTAL_TOKENS
  AGENT_MAX_TOOL_CALLS        cap on tool calls per run
  AGENT_TOOL_APPROVAL         autopilot | ask-writes | ask-all | read-only
  AGENT_SKILLS_DIR            folder of <skill>/SKILL.md skills
  AGENT_CONTEXT_WINDOW_TOKENS model window (auto-compaction threshold = 50%)
  AGENT_COMPACTION            off disables automatic compaction

Commands inside the REPL:
  /status, /tools, /history, /reset, /reconnect, /exit
  /compact                    summarise the conversation history now
  /autopilot                  toggle autopilot (no tool approval prompts)
  /approval <mode>            autopilot | ask-writes | ask-all | read-only

When the approval mode asks, answer y (allow once), n (deny) or a (always
allow this tool for the session).
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
