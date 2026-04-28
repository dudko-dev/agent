import { HELP, type ICliArgs, parseCliArgs } from './args.ts'
import { runRepl } from './run.ts'

const main = async (): Promise<void> => {
  let args: ICliArgs
  try {
    args = parseCliArgs(process.argv.slice(2))
  } catch (err) {
    console.error((err as Error).message)
    console.error('\nRun `dd-agent --help` for usage.')
    process.exit(2)
  }
  if (args.help) {
    process.stdout.write(HELP)
    return
  }
  if (args.envFile) {
    try {
      process.loadEnvFile(args.envFile)
    } catch (err) {
      console.error(`Failed to load env file ${args.envFile}: ${(err as Error).message}`)
      process.exit(2)
    }
  }
  // Apply --flag overrides AFTER --env-file so flags always win, even when an
  // env-file already set the same key. Mutating process.env is local to this
  // CLI process; it never leaks out via inheritance because Node only forks
  // child env from this point onward (we don't spawn anything user-visible).
  for (const [k, v] of Object.entries(args.overrides)) {
    process.env[k] = v
  }
  try {
    await runRepl()
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    if (msg.startsWith('Missing required env var')) {
      // Friendlier surface for the most common misconfiguration: the user
      // started the CLI without --env-file and without exporting the vars.
      console.error(
        `${msg}\n\nRun \`dd-agent --help\` to see required env vars, or pass --env-file=<path>.`,
      )
      process.exit(2)
    }
    throw err
  }
}

main().catch((err: unknown) => {
  console.error(err)
  process.exit(1)
})
