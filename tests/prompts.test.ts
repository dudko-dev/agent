import assert from 'node:assert/strict'
import test from 'node:test'
import {
  EXECUTOR_SYSTEM,
  buildPlannerSystem,
  renderHistory,
  renderToolCatalog,
  renderTrace,
} from '../src/prompts.ts'
import type { IStepResult } from '../src/types.ts'

test('renderHistory shows placeholder when empty', () => {
  assert.equal(renderHistory(undefined), '(no prior conversation)')
  assert.equal(renderHistory([]), '(no prior conversation)')
})

test('renderHistory keeps only the last 8 turns and notes how many were dropped', () => {
  const turns = Array.from({ length: 12 }, (_, i) => ({
    role: 'user' as const,
    content: `turn ${i}`,
  }))
  const out = renderHistory(turns)
  assert.match(out, /^\(4 earlier turns omitted\)/)
  assert.match(out, /turn 11/)
  assert.equal(out.includes('turn 0'), false)
})

test('renderHistory truncates long turn content with a marker', () => {
  const turns = [{ role: 'user' as const, content: 'x'.repeat(2000) }]
  const out = renderHistory(turns)
  assert.match(out, /\.\.\. \[truncated\]$/)
})

test('renderToolCatalog: empty catalog returns placeholder', () => {
  assert.equal(renderToolCatalog([]), '(no tools available)')
})

test('renderToolCatalog: full mode trims descriptions to 240 chars', () => {
  const out = renderToolCatalog([{ name: 't', description: 'a'.repeat(500) }], 'full')
  // 240 desc-chars + name + "- " + ": "
  const aRun = out.match(/a+/g)?.[0] ?? ''
  assert.equal(aRun.length, 240)
})

test('renderToolCatalog: compact mode caps desc at 80 chars', () => {
  const out = renderToolCatalog([{ name: 't', description: 'a'.repeat(500) }], 'compact')
  const aRun = out.match(/a+/g)?.[0] ?? ''
  assert.equal(aRun.length, 80)
})

test('renderToolCatalog: notes how many tools were sliced off', () => {
  const cat = Array.from({ length: 100 }, (_, i) => ({ name: `t${i}`, description: 'd' }))
  const out = renderToolCatalog(cat, 'full') // limit 80
  assert.match(out, /\.\.\. and 20 more tools/)
})

test('renderTrace: empty trace returns placeholder', () => {
  assert.equal(renderTrace([]), '(no steps executed yet)')
})

test('renderTrace: shows tool calls with ok / fail status', () => {
  const trace: IStepResult[] = [
    {
      step: { id: 's1', description: 'd', expectedOutcome: 'e' },
      summary: 'done',
      toolCalls: [
        { name: 't1', input: {}, output: 'ok-out', ok: true },
        { name: 't2', input: {}, output: 'err-out', ok: false },
      ],
      durationMs: 5,
      blocked: false,
    },
  ]
  const out = renderTrace(trace)
  assert.match(out, /Step 1: d/)
  assert.match(out, /t1 ok/)
  assert.match(out, /t2 fail/)
})

test('buildPlannerSystem appends narrowed addendum only in compact mode', () => {
  const full = buildPlannerSystem('full')
  const compact = buildPlannerSystem('compact')
  assert.equal(full.includes('tool-narrowed mode'), false)
  assert.equal(compact.includes('tool-narrowed mode'), true)
})

test('EXECUTOR_SYSTEM mentions the [BLOCKER] sentinel for downstream replanner', () => {
  assert.match(EXECUTOR_SYSTEM, /\[BLOCKER\]/)
})
