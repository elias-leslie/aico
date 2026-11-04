import { describe, expect, it } from 'vitest'
import { parseRow } from './row'
import { type StoredRow, view } from './show'

const NOW = Date.parse('2026-11-03T12:00:00Z')

function stored(fields: Record<string, unknown>, updated = '2026-11-03T11:00:00Z'): StoredRow {
  return {
    row: parseRow({ kind: 'job', machine: 'a', state: 'ok', meaning: 'Fine.', ...fields }),
    updatedAt: Date.parse(updated),
  }
}

const ROWS = [
  stored({ id: 'a/one', what: 'One', project: 'aico', next_run: '2026-11-03T13:00:00Z' }),
  stored({ id: 'a/two', what: 'Two', kind: 'check', state: 'failed', meaning: 'Disk full.' }),
  stored(
    { id: 'b/three', what: 'Three', machine: 'b', next_run: '2026-11-03T11:00:00Z' },
    '2026-11-03T11:30:00Z',
  ),
  stored({ id: 'b/four', what: 'Four', machine: 'b', state: 'off', meaning: 'Paused.' }),
]

/** Machine rows for a and b, reporting: without one a machine's rows show unknown. */
const machine = (name: string) =>
  stored({
    id: `${name}/machine`,
    what: name,
    kind: 'machine',
    machine: name,
    next_run: '2026-11-03T13:00:00Z',
  })
const ALL = [...ROWS, machine('a'), machine('b')]

const ids = (filter: Parameters<typeof view>[2]) =>
  view(ALL, NOW, filter)
    .rows.filter((row) => row.kind !== 'machine')
    .map((row) => row.id)

describe('view', () => {
  it('puts problems first and folds the rest into a healthy count', () => {
    const result = view(ALL, NOW)
    expect(result.rows.map((row) => [row.id, row.shown])).toEqual([
      ['a/two', 'failed'],
      ['b/three', 'late'],
      ['a/one', 'ok'],
      ['a/machine', 'ok'],
      ['b/machine', 'ok'],
      ['b/four', 'off'],
    ])
    expect(result.rollup).toEqual({
      problems: 2,
      healthy: 4,
      counts: { failed: 1, late: 1, unknown: 0, warn: 0, ok: 3, off: 1 },
    })
    expect(result.generated_at).toBe('2026-11-03T12:00:00.000Z')
  })

  it('a row is late only after its next run has passed', () => {
    const due = [stored({ id: 'a/x', what: 'X', next_run: '2026-11-03T12:00:00Z' }), machine('a')]
    expect(view(due, NOW).rows[0]?.shown).toBe('ok')
    expect(view(due, NOW + 1).rows[0]).toMatchObject({
      shown: 'late',
      shown_since: '2026-11-03T12:00:00.000Z',
    })
  })

  it('filters by shown state, kind, machine, project and text', () => {
    expect(ids({ state: ['late', 'failed'] })).toEqual(['a/two', 'b/three'])
    expect(ids({ kind: ['check'] })).toEqual(['a/two'])
    expect(ids({ machine: ['b'] })).toEqual(['b/three', 'b/four'])
    expect(ids({ project: ['aico'] })).toEqual(['a/one'])
    expect(ids({ search: 'DISK' })).toEqual(['a/two'])
    expect(view(ALL, NOW, { machine: ['b'] }).rollup).toMatchObject({ problems: 1, healthy: 2 })
  })

  it('shows the rows of a machine with no machine row as unknown', () => {
    expect(view([stored({ id: 'c/x', what: 'X', machine: 'c' })], NOW).rows[0]).toMatchObject({
      shown: 'unknown',
      shown_since: null,
    })
  })

  it('sorts by what, newest update or soonest next run', () => {
    expect(ids({ sort: 'what' })).toEqual(['b/four', 'a/one', 'b/three', 'a/two'])
    expect(ids({ sort: 'updated' })).toEqual(['b/three', 'b/four', 'a/one', 'a/two'])
    expect(ids({ sort: 'next' })).toEqual(['b/three', 'a/one', 'b/four', 'a/two'])
  })

  it('says why a row is unknown and keeps a machine turned off on purpose out of the badge', () => {
    const rows = [
      ...ALL,
      stored({
        id: 'c/machine',
        what: 'c',
        kind: 'machine',
        machine: 'c',
        state: 'off',
        next_run: '2026-11-03T13:00:00Z',
      }),
      stored({ id: 'c/job', what: 'C job', machine: 'c', state: 'failed', meaning: 'Broke.' }),
      stored({ id: 'd/job', what: 'D job', machine: 'd' }),
    ]
    const result = view(rows, NOW)
    const byId = new Map(result.rows.map((row) => [row.id, row]))
    expect(byId.get('c/job')).toMatchObject({ shown: 'unknown', unknown_why: 'off' })
    expect(byId.get('d/job')).toMatchObject({ shown: 'unknown', unknown_why: 'missing' })
    expect(byId.get('a/one')?.unknown_why).toBeUndefined()
    // The screen still counts both unknown rows; the badge leaves out c's.
    expect(result.rollup.counts.unknown).toBe(2)
    expect(result.summary).toMatchObject({
      problems: 3,
      worst: 'failed',
      counts: { failed: 1, late: 1, unknown: 1, warn: 0 },
      quiet: 1,
    })
    expect(result.summary.top.map((row) => row.id)).toEqual(['a/two', 'b/three', 'd/job'])
    // The summary covers every row, whatever the filter.
    expect(view(rows, NOW, { machine: ['a'] }).summary.problems).toBe(3)
  })
})
