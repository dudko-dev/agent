import { test } from 'node:test'
import assert from 'node:assert/strict'
import { zodSchema } from '@ai-sdk/provider-utils'
import type { z } from 'zod'
import { PlanSchema } from '../src/planner.ts'
import { DecisionSchema } from '../src/replanner.ts'

// Anthropic's native structured output (output_config.format.schema) rejects
// `maxItems` on array types. This test guards against re-introducing it.
const FORBIDDEN = ['maxItems'] as const

const collect = (node: unknown, path: string, hits: string[]): void => {
  if (!node || typeof node !== 'object') return
  for (const [k, v] of Object.entries(node)) {
    if ((FORBIDDEN as readonly string[]).includes(k)) {
      hits.push(`${path}.${k} = ${JSON.stringify(v)}`)
    }
    collect(v, `${path}.${k}`, hits)
  }
}

const cases: ReadonlyArray<readonly [string, z.ZodType]> = [
  ['PlanSchema', PlanSchema],
  ['DecisionSchema (replanner)', DecisionSchema],
]

for (const [name, schema] of cases) {
  test(`${name}: produces no forbidden Anthropic-incompatible JSON Schema keywords`, () => {
    const js = zodSchema(schema).jsonSchema
    const hits: string[] = []
    collect(js, '$', hits)
    assert.deepEqual(hits, [], `${name} contains forbidden keys: ${hits.join(', ')}`)
  })
}
