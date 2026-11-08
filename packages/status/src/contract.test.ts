// The TypeScript side of the Status row contract: row.ts agrees with
// contracts/status-row.schema.json and replays contracts/status-row-fixtures.json.
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { ACTION_KINDS, KINDS, LIMITS, parseRow, RowError, STATES } from './row'
import { type StoredRow, view } from './show'

const read = (name: string) =>
  JSON.parse(readFileSync(fileURLToPath(new URL(`../../../${name}`, import.meta.url)), 'utf8'))
const schema = read('contracts/status-row.schema.json')
const fixtures = read('contracts/status-row-fixtures.json')
const props = schema.properties

describe('row.ts matches the schema', () => {
  it('has the same fields, required fields, lists and limits', () => {
    expect(schema.required).toEqual(['id', 'what', 'kind', 'machine', 'state', 'meaning'])
    expect(Object.keys(props).sort()).toEqual([
      'actions',
      'id',
      'kind',
      'last_run',
      'machine',
      'meaning',
      'next_run',
      'project',
      'run_by',
      'state',
      'what',
    ])
    expect(props.kind.enum).toEqual([...KINDS])
    expect(props.state.enum).toEqual([...STATES])
    expect(props.actions.items.properties.kind.enum).toEqual([...ACTION_KINDS])
    expect(props.actions.maxItems).toBe(LIMITS.actions.max)
    expect(props.actions.items.properties.ref.maxLength).toBe(LIMITS.actions.ref)
    for (const field of ['id', 'machine', 'project'] as const) {
      expect(props[field].pattern).toBe(LIMITS[field].pattern.source)
      expect(props[field].maxLength).toBe(LIMITS[field].max)
    }
    expect(schema.if).toEqual({ properties: { kind: { const: 'machine' } }, required: ['kind'] })
    expect(schema.then).toEqual({ required: ['next_run'] })
    expect(props.what.maxLength).toBe(LIMITS.what.max)
    expect(props.meaning.maxLength).toBe(LIMITS.meaning.max)
    expect(props.run_by.pattern).toBe(LIMITS.id.pattern.source)
    expect(props.run_by.maxLength).toBe(LIMITS.id.max)
    expect(schema.dependentRequired).toEqual({ run_by: ['next_run'] })
  })
})

interface Fixtures {
  valid: { name: string; row: unknown }[]
  invalid: { name: string; row: unknown; field: string }[]
  replay: {
    name: string
    now: string
    rows: { row: unknown; updated_at: string }[]
    expect: { id: string; shown: string; shown_since: string | null }[]
    rollup: { problems: number; healthy: number }
  }[]
}

describe('fixtures', () => {
  const { valid, invalid, replay } = fixtures as Fixtures
  for (const item of valid)
    it(`accepts ${item.name}`, () => {
      expect(parseRow(item.row).id).toBe((item.row as { id: string }).id)
    })

  for (const item of invalid)
    it(`refuses ${item.name}`, () => {
      let error: unknown
      try {
        parseRow(item.row)
      } catch (caught) {
        error = caught
      }
      expect(error).toBeInstanceOf(RowError)
      expect((error as RowError).field).toBe(item.field)
    })

  for (const item of replay)
    it(`replays ${item.name}`, () => {
      const stored: StoredRow[] = item.rows.map(({ row, updated_at }) => ({
        row: parseRow(row),
        updatedAt: Date.parse(updated_at),
      }))
      const result = view(stored, Date.parse(item.now))
      expect(result.rows.map(({ id, shown, shown_since }) => ({ id, shown, shown_since }))).toEqual(
        item.expect,
      )
      const { problems, healthy } = result.rollup
      expect({ problems, healthy }).toEqual(item.rollup)
    })
})

describe('parseRow', () => {
  it('normalizes times to UTC', () => {
    const row = parseRow({ ...fixtures.valid[0].row, last_run: '2026-11-02T22:30:00-05:00' })
    expect(row.last_run).toBe('2026-11-03T03:30:00.000Z')
  })

  it('refuses February 30th', () => {
    expect(() => parseRow({ ...fixtures.valid[0].row, next_run: '2026-02-30T00:00:00Z' })).toThrow(
      RowError,
    )
  })

  it('requires a deadline when naming the job that writes a row', () => {
    expect(() => parseRow({ ...fixtures.valid[0].row, run_by: 'jobs/nightly' })).toThrow(
      'run_by needs next_run',
    )
  })
})
