import { describe, expect, it } from 'vitest'
import {
  ageByTarget,
  type BackupEntry,
  backupSummary,
  groupBySource,
} from './backups'

const entry = (over: Partial<BackupEntry>): BackupEntry => ({
  id: `${over.target ?? 'native'}/${over.source ?? 'a'}`,
  source: 'a',
  name: 'A',
  target: 'native',
  dataAt: null,
  nextRun: null,
  state: 'ok',
  meaning: '',
  snapshot: null,
  path: null,
  machine: 'm',
  ...over,
})

describe('backupSummary', () => {
  it('says all current and how many are archived', () => {
    const list = [
      ...Array.from({ length: 3 }, (_, i) => entry({ source: `s${i}` })),
      entry({ source: 'old', state: 'off', gone: true }),
      entry({ source: 'old', state: 'off', gone: true, target: 'drive' }),
    ]
    expect(backupSummary(list)).toBe(
      'All 3 sources current (3 copies), 1 archived.',
    )
  })

  it('counts a machine that is off apart from archived sources, one per source', () => {
    const list = [
      entry({ source: 'a' }),
      entry({ source: 'old', state: 'off', gone: true }),
      entry({ source: 'jobs', state: 'off' }),
      entry({ source: 'jobs', state: 'off', target: 'external' }),
    ]
    expect(backupSummary(list)).toBe(
      'All 1 source current (1 copy), 1 on a machine that is off, 1 archived.',
    )
  })

  it('counts a source once and its copies beside it', () => {
    const list = [
      entry({ source: 'a' }),
      entry({ source: 'a', target: 'drive' }),
      entry({ source: 'a', target: 'append' }),
    ]
    expect(backupSummary(list)).toBe('All 1 source current (3 copies).')
  })

  it('leads with what is wrong', () => {
    const list = [
      entry({ source: 'a', state: 'failed' }),
      entry({ source: 'b', state: 'warn' }),
      entry({ source: 'c' }),
    ]
    expect(backupSummary(list)).toBe(
      '1 failed, 1 needs a fresh copy, 1 source current (1 copy).',
    )
  })

  it('does not call an empty list healthy', () => {
    expect(backupSummary([])).toBe('No backups are registered yet.')
  })
})

describe('groupBySource', () => {
  it('puts a source once with its copies in T7, Drive order and the worst state first', () => {
    const groups = groupBySource([
      entry({ source: 'b', name: 'B', target: 'drive', state: 'warn' }),
      entry({ source: 'a', name: 'A', target: 'drive' }),
      entry({ source: 'b', name: 'B', target: 'native' }),
      entry({ source: 'gone', name: 'Gone', state: 'off' }),
    ])
    expect(groups.map((g) => g.source)).toEqual(['b', 'a', 'gone'])
    expect(groups[0]?.state).toBe('warn')
    expect(groups[0]?.copies.map((c) => c.target)).toEqual(['native', 'drive'])
    expect(groups[2]?.state).toBe('off')
  })
})

describe('ageByTarget', () => {
  const now = Date.parse('2026-11-07T12:00:00Z')
  const hoursAgo = (h: number) => new Date(now - h * 3_600_000).toISOString()

  it('shows each destination by its most overdue copy against that copy limit', () => {
    const list = [
      entry({ source: 'a', dataAt: hoursAgo(1), limitHours: 6 }),
      entry({ source: 'b', name: 'Beta', dataAt: hoursAgo(4), limitHours: 6 }),
      entry({
        source: 'a',
        target: 'drive',
        dataAt: hoursAgo(30),
        limitHours: 26,
      }),
    ]
    const ages = ageByTarget(list, now)
    expect(ages.map((age) => age.target)).toEqual(['drive', 'native'])
    expect(ages[1]).toMatchObject({ name: 'Beta', copies: 2 })
    expect(ages[1]?.ageMs).toBe(4 * 3_600_000)
  })

  it('leaves out archived copies, a machine that is off and copies with no date', () => {
    const list = [
      entry({ source: 'old', gone: true, state: 'off', limitHours: 6 }),
      entry({ source: 'jobs', state: 'off', limitHours: 6 }),
      entry({ source: 'new', dataAt: null, limitHours: 6 }),
    ]
    expect(ageByTarget(list, now)).toEqual([])
  })
})
