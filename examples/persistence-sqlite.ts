// Example: durable run snapshots in a local SQLite file using node:sqlite
// (built into Node.js since 22.5; no external dependency).
//
// Wire it into createAgent via `persistence: makeSqlitePersistence('./runs.db')`.
// On every run: a row is written at start, updated after each step, and
// finalized on completion. Schema is created lazily on first use.

import { DatabaseSync } from 'node:sqlite'
import type { IPersistence, IRunSnapshot } from '../src/index.ts'

export const makeSqlitePersistence = (filePath: string): IPersistence => {
  const db = new DatabaseSync(filePath)
  db.exec(`
    CREATE TABLE IF NOT EXISTS agent_runs (
      run_id TEXT PRIMARY KEY,
      status TEXT NOT NULL,
      started_at INTEGER NOT NULL,
      completed_at INTEGER,
      input TEXT NOT NULL,
      plan TEXT,
      trace TEXT NOT NULL,
      usage TEXT NOT NULL,
      result_text TEXT,
      error TEXT
    );
    CREATE INDEX IF NOT EXISTS agent_runs_started_at_idx
      ON agent_runs (started_at DESC);
  `)

  // Prepared once: hot path is the per-step UPDATE.
  const upsert = db.prepare(`
    INSERT INTO agent_runs
      (run_id, status, started_at, completed_at, input, plan, trace, usage, result_text, error)
    VALUES
      (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(run_id) DO UPDATE SET
      status = excluded.status,
      completed_at = excluded.completed_at,
      plan = excluded.plan,
      trace = excluded.trace,
      usage = excluded.usage,
      result_text = excluded.result_text,
      error = excluded.error
  `)

  const write = (s: IRunSnapshot): void => {
    upsert.run(
      s.runId,
      s.status,
      s.startedAt,
      s.completedAt ?? null,
      s.input,
      s.plan ? JSON.stringify(s.plan) : null,
      JSON.stringify(s.trace),
      JSON.stringify(s.usage),
      s.text ?? null,
      s.error ?? null,
    )
  }

  return {
    onRunStart: (snapshot) => write(snapshot),
    onStepComplete: (snapshot) => write(snapshot),
    onRunComplete: (snapshot) => write(snapshot),
  }
}
