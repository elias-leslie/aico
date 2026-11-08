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
const machineRow = (name: string) => ({
  id: `${name}/machine`,
  what: name,
  kind: 'machine',
  machine: name,
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

  it('shows rows of a machine turned off on purpose as off, with the last report, not as problems', () => {
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
    expect(byId.get('c/job')).toMatchObject({
      shown: 'off',
      machine_off: true,
      state: 'failed',
      meaning: 'Broke.',
      shown_since: expect.any(String),
    })
    expect(byId.get('c/job')?.unknown_why).toBeUndefined()
    expect(byId.get('c/machine')?.machine_off).toBeUndefined()
    expect(byId.get('d/job')).toMatchObject({ shown: 'unknown', unknown_why: 'missing' })
    expect(byId.get('a/one')?.unknown_why).toBeUndefined()
    // c's rows are off, not unknown: the screen and the badge count only d's as unknown.
    expect(result.rollup.counts.unknown).toBe(1)
    expect(result.rollup.counts.off).toBe(3)
    expect(result.rollup.problems).toBe(3)
    expect(result.rows.slice(-3).map((row) => row.shown)).toEqual(['off', 'off', 'off'])
    expect(result.summary).toMatchObject({
      problems: 3,
      worst: 'failed',
      counts: { failed: 1, late: 1, unknown: 1, warn: 0 },
      quiet: 0,
    })
    expect(result.summary.top.map((row) => row.id)).toEqual(['a/two', 'b/three', 'd/job'])
    // The summary covers every row, whatever the filter.
    expect(view(rows, NOW, { machine: ['a'] }).summary.problems).toBe(3)
  })

  it('lists problems by what they cost, then by state, with healthy rows after', () => {
    const rows = [
      stored({ id: 'a/check-perf', kind: 'check', what: 'Workstation performance', state: 'warn' }),
      stored({ id: 'a/aico-web', kind: 'service', what: 'Aico web', state: 'failed' }),
      stored({ id: 'a/check-sudo', kind: 'check', what: 'Sudo use', state: 'warn' }),
      stored({ id: 'a/check-memory', kind: 'check', what: 'Memory', state: 'warn' }),
      stored({ id: 'a/job-fine', kind: 'job', what: 'A fine job', state: 'ok' }),
      machine('a'),
    ]
    const result = view(rows, NOW)
    expect(result.rows.map((row) => row.id).slice(0, 5)).toEqual([
      'a/check-memory',
      'a/check-sudo',
      'a/aico-web',
      'a/check-perf',
      'a/job-fine',
    ])
    // The badge's worst state is still the worst state, not the first row's.
    expect(result.summary.worst).toBe('failed')
    expect(result.summary.top.map((row) => row.id)).toEqual([
      'a/check-memory',
      'a/check-sudo',
      'a/aico-web',
    ])
  })
  it('counts as needing the owner only a failed or late backup, a down machine, a failed service or an owner-only failure', () => {
    const owner = [{ kind: 'run', ref: 'approve', owner_only: true }]
    const rows = [
      stored({ id: 'a/check-sudo', kind: 'check', what: 'Sudo use', state: 'warn' }),
      stored({ id: 'a/check-build', kind: 'check', what: 'Build', state: 'failed' }),
      stored({ id: 'a/job-late', what: 'Late job', next_run: '2026-11-03T11:00:00Z' }),
      stored({ id: 'a/ask', what: 'Ask', state: 'failed', actions: owner }),
      machine('a'),
    ]
    const result = view(rows, NOW).summary
    expect(result.problems).toBe(4)
    expect(result.needs).toBe(1)
    const more = [
      ...rows,
      stored({ id: 'a/backup', kind: 'backup', what: 'Backup', state: 'failed' }),
      stored({ id: 'a/web', kind: 'service', what: 'Web', state: 'failed' }),
    ]
    expect(view(more, NOW).summary.needs).toBe(3)
    // A machine expected up that stopped reporting counts; one expected off (parked) does not.
    const down = [machine('a'), stored({ ...machineRow('b'), next_run: '2026-11-03T11:00:00Z' })]
    expect(view(down, NOW).summary.needs).toBe(1)
    expect(view(down, NOW, {}, new Map([['b', NOW - 1000]])).summary.needs).toBe(0)
    // A row off with its machine never needs anyone.
    const off = [
      stored({ ...machineRow('b'), next_run: '2026-11-03T11:00:00Z' }),
      stored({ id: 'b/backup', machine: 'b', kind: 'backup', what: 'B backup', state: 'failed' }),
    ]
    expect(view(off, NOW, {}, new Map([['b', NOW - 1000]])).summary.needs).toBe(0)
  })
})
