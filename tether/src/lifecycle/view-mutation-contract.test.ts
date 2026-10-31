import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { parseLabel, parseWidgetMutation } from './root-control'

// The same vectors drive scripts/tests/test_view_mutation_contract.py, so the
// owner and its Python client cannot drift silently.
const vectors = JSON.parse(
  readFileSync(
    fileURLToPath(new URL('../../contracts/view-mutation-vectors.json', import.meta.url)),
    'utf8',
  ),
) as {
  version: number
  labels: { input: string; label: string | null }[]
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

  it('accepts exactly one field per mutation kind', () => {
    const generation = 'a'.repeat(64)
    expect(parseWidgetMutation('title', { generation, label: ' Focus ' })?.mutation).toEqual({
      kind: 'title',
      label: 'Focus',
    })
    expect(
      parseWidgetMutation('coordinator', { generation, coordinator: false })?.mutation,
    ).toEqual({ kind: 'coordinator', coordinator: false })
    expect(
      parseWidgetMutation('coordinator', { generation, coordinator: 'd2852144' })?.mutation,
    ).toEqual({ kind: 'coordinator', coordinator: 'd2852144' })
    for (const [kind, body] of [
      ['coordinator', { generation }],
      ['coordinator', { generation, coordinator: 'on' }],
      ['coordinator', { generation, coordinator: true, label: 'Focus' }],
      ['title', { generation }],
      ['title', { generation: 'A'.repeat(64), label: 'Focus' }],
      ['title', null],
    ] as const) {
      expect(parseWidgetMutation(kind, body)).toBeNull()
    }
  })
})
