import { parseArgs } from 'node:util'

export interface ICliArgs {
  envFile?: string
  help: boolean
}

export const HELP = `Usage: dd-agent [options]

Options:
  --env-file=<path>   Load env vars from a dotenv file before starting
  -h, --help          Show this help

Required env vars (set directly or via --env-file):
  AGENT_PROVIDER_TYPE   one of: openai | anthropic | openai-compatible | google
  AGENT_API_KEY         provider API key
  AGENT_MODEL           model id
  MCP_SERVERS           JSON: { "<name>": { "url": "...", "headers"?: {...} } }

Commands inside the REPL:
  /status, /tools, /history, /reset, /reconnect, /exit
`

export const parseCliArgs = (argv: string[]): ICliArgs => {
  const { values } = parseArgs({
    args: argv,
    options: {
      'env-file': { type: 'string' },
      help: { type: 'boolean', short: 'h' },
    },
    strict: true,
    allowPositionals: false,
  })
  return {
    envFile: values['env-file'],
    help: Boolean(values.help),
  }
}
