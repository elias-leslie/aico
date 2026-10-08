import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { parseBounds, parseLabel, parseWidgetMutation } from './root-control'

// The same vectors drive scripts/tests/test_view_mutation_contract.py, so the
// owner and its Python client cannot drift silently.
const vectors = JSON.parse(
  readFileSync(join(process.cwd(), 'contracts/view-mutation-vectors.json'), 'utf8'),
) as {
  version: number
  labels: { input: string; label: string | null }[]
  bounds: { input: unknown; valid: boolean }[]
}

describe('shared view-mutation contract vectors', () => {
  it('pins label trimming and validation', () => {
    expect(vectors.version).toBe(1)
    for (const vector of vectors.labels) {
      expect([JSON.stringify(vector.input), parseLabel(vector.input)]).toEqual([
        JSON.stringify(vector.input),
        vector.label,
      ])
    }
  })

  it('pins integer bounds validation', () => {
    for (const vector of vectors.bounds) {
      expect([JSON.stringify(vector.input), parseBounds(vector.input) !== null]).toEqual([
        JSON.stringify(vector.input),
        vector.valid,
      ])
    }
  })

  it('accepts exactly one field per mutation kind', () => {
    const generation = 'a'.repeat(64)
    const bounds = { x: 0, y: 0, width: 360, height: 240 }
    expect(parseWidgetMutation('show', { generation })).toEqual({
      generation,
      mutation: { kind: 'show' },
    })
    expect(parseWidgetMutation('position', { generation, bounds })?.mutation).toEqual({
      kind: 'position',
      bounds,
    })
    expect(parseWidgetMutation('title', { generation, label: ' Focus ' })?.mutation).toEqual({
      kind: 'title',
      label: 'Focus',
    })
    for (const [kind, body] of [
      ['show', { generation, label: 'Focus' }],
      ['show', {}],
      ['position', { generation }],
      ['position', { generation, bounds, label: 'Focus' }],
      ['title', { generation }],
      ['title', { generation: 'A'.repeat(64), label: 'Focus' }],
      ['title', null],
    ] as const) {
      expect(parseWidgetMutation(kind, body)).toBeNull()
    }
  })
})
