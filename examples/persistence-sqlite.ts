// Example: durable run snapshots in a local SQLite file using node:sqlite
// (built into Node.js since 22.5; no external dependency).
//
// Wire it into createAgent via `persistence: makeSqlitePersistence('./runs.db')`.
// On every run: a row is written at start, updated after each step, and
// finalized on completion. Schema is created lazily on first use.

import { DatabaseSync } from 'node:sqlite'
import type {
  IConversationTurn,
  IPersistence,
  IPlan,
  IRunSnapshot,
  IStepResult,
  IUsage,
} from '../src/index.ts'

// Returned alongside the IPersistence facade so the caller can release the
// DB handle on shutdown - a long-lived agent process inherits the handle and
// node:sqlite will release it on exit, but tests / scripts should close
// explicitly to avoid lingering file locks.
export interface ISqlitePersistence extends IPersistence {
  close: () => void
}

export const makeSqlitePersistence = (filePath: string): ISqlitePersistence => {
  const db = new DatabaseSync(filePath)
  // WAL gives us concurrent readers + a single writer with sane crash-safety.
  // For a single-process agent this is mostly a perf win; for multiple
  // processes sharing one DB it's the correct journaling mode.
  db.exec('PRAGMA journal_mode = WAL;')
  db.exec(`
    CREATE TABLE IF NOT EXISTS agent_runs (
      run_id TEXT PRIMARY KEY,
      status TEXT NOT NULL,
      started_at INTEGER NOT NULL,
      completed_at INTEGER,
      input TEXT NOT NULL,
      history TEXT,
      plan TEXT,
      trace TEXT NOT NULL,
      usage TEXT NOT NULL,
      step_index INTEGER NOT NULL,
      iterations INTEGER NOT NULL,
      revisions INTEGER NOT NULL,
      result_text TEXT,
      error TEXT
    );
    CREATE INDEX IF NOT EXISTS agent_runs_started_at_idx
      ON agent_runs (started_at DESC);
  `)

  // Prepared once: hot path is the per-step UPSERT during a long run.
  const upsert = db.prepare(`
    INSERT INTO agent_runs
      (run_id, status, started_at, completed_at, input, history, plan, trace, usage,
       step_index, iterations, revisions, result_text, error)
    VALUES
      (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(run_id) DO UPDATE SET
      status = excluded.status,
      completed_at = excluded.completed_at,
      history = excluded.history,
      plan = excluded.plan,
      trace = excluded.trace,
      usage = excluded.usage,
      step_index = excluded.step_index,
      iterations = excluded.iterations,
      revisions = excluded.revisions,
      result_text = excluded.result_text,
      error = excluded.error
  `)

  const select = db.prepare(`SELECT * FROM agent_runs WHERE run_id = ?`)

  const write = (s: IRunSnapshot): void => {
    upsert.run(
      s.runId,
      s.status,
      s.startedAt,
      s.completedAt ?? null,
      s.input,
      s.history ? JSON.stringify(s.history) : null,
      s.plan ? JSON.stringify(s.plan) : null,
      JSON.stringify(s.trace),
      JSON.stringify(s.usage),
      s.stepIndex,
      s.iterations,
      s.revisions,
      s.text ?? null,
      s.error ?? null,
    )
  }

  // Row shape from the SELECT above. node:sqlite returns columns as a flat
  // record; we narrow to the columns we wrote to keep the parser explicit.
  type Row = {
    run_id: string
    status: IRunSnapshot['status']
    started_at: number
    completed_at: number | null
    input: string
    history: string | null
    plan: string | null
    trace: string
    usage: string
    step_index: number
    iterations: number
    revisions: number
    result_text: string | null
    error: string | null
  }

  const read = (runId: string): IRunSnapshot | null => {
    const row = select.get(runId) as Row | undefined
    if (!row) {
      return null
    }
    return {
      runId: row.run_id,
      status: row.status,
      startedAt: row.started_at,
      completedAt: row.completed_at ?? undefined,
      input: row.input,
      history: row.history ? (JSON.parse(row.history) as IConversationTurn[]) : undefined,
      plan: row.plan ? (JSON.parse(row.plan) as IPlan) : undefined,
      trace: JSON.parse(row.trace) as IStepResult[],
      usage: JSON.parse(row.usage) as IUsage,
      stepIndex: row.step_index,
      iterations: row.iterations,
      revisions: row.revisions,
      text: row.result_text ?? undefined,
      error: row.error ?? undefined,
    }
  }

  return {
    onRunStart: (snapshot) => write(snapshot),
    onStepComplete: (snapshot) => write(snapshot),
    onRunComplete: (snapshot) => write(snapshot),
    loadRun: (runId) => read(runId),
    close: () => db.close(),
  }
}
