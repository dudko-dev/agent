import type { SubagentInfo } from '../control.ts'

// What a line typed WHILE a run goes means. Pure, so it is tested without a terminal.
export type LiveLine =
  // Text for the running agent: shown to the model at its next boundary.
  | { kind: 'say'; text: string }
  // /agents - list the running subagents.
  | { kind: 'agents' }
  // /stop [n|id] - stop one subagent (not the run: Ctrl-C does that).
  | { kind: 'stop'; target: string }
  // Some other /command: those work between runs, not during one.
  | { kind: 'hint' }
  | { kind: 'ignore' }

export const parseLiveLine = (raw: string): LiveLine => {
  const text = raw.trim()
  if (!text) {
    return { kind: 'ignore' }
  }
  if (text === '/agents') {
    return { kind: 'agents' }
  }
  if (text === '/stop' || text.startsWith('/stop ')) {
    return { kind: 'stop', target: text.slice('/stop'.length).trim() }
  }
  // "/etc/hosts is the file" is a message; "/compact" is a command.
  if (/^\/[\w-]+(\s|$)/.test(text)) {
    return { kind: 'hint' }
  }
  return { kind: 'say', text }
}

// The 8-character tag the REPL shows for a subagent; /stop accepts it (or any unique prefix).
export const shortId = (id: string): string => id.slice(0, 8)

// Which running subagent `/stop <target>` means: a 1-based number from /agents, or a unique id
// prefix; with no target, the only one running. A string is the reason it cannot be told.
export const resolveSubagent = (running: SubagentInfo[], target: string): SubagentInfo | string => {
  if (running.length === 0) {
    return 'no subagent is running'
  }
  if (!target) {
    return running.length === 1
      ? running[0]
      : `${running.length} subagents are running - say which: /stop <number>  (see /agents)`
  }
  if (/^\d+$/.test(target)) {
    const picked = running[Number(target) - 1]
    return picked ?? `there is no subagent number ${target} (${running.length} running)`
  }
  const matches = running.filter((s) => s.id.startsWith(target))
  if (matches.length === 1) {
    return matches[0]
  }
  return matches.length === 0
    ? `no running subagent has an id starting with "${target}"`
    : `"${target}" matches ${matches.length} subagents - give more of the id`
}

// One line per running subagent for /agents.
export const describeSubagents = (running: SubagentInfo[], now = Date.now()): string[] =>
  running.map((s, i) => {
    const secs = Math.max(0, Math.round((now - s.startedAt) / 1000))
    const task = s.task.replace(/\s+/g, ' ').trim()
    return `  ${i + 1}. ${s.name}${s.profile ? ` [${s.profile}]` : ''} ${shortId(s.id)} (${secs}s): ${task.length > 100 ? `${task.slice(0, 100)}...` : task}`
  })
