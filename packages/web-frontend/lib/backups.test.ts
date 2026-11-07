import { describe, expect, it } from 'vitest'
import { type BackupEntry, backupSummary, groupBySource } from './backups'

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
    expect(backupSummary(list)).toBe('All 3 current, 1 archived.')
  })

  it('counts a machine that is off apart from archived sources, one per source', () => {
    const list = [
      entry({ source: 'a' }),
      entry({ source: 'old', state: 'off', gone: true }),
      entry({ source: 'jobs', state: 'off' }),
      entry({ source: 'jobs', state: 'off', target: 'external' }),
    ]
    expect(backupSummary(list)).toBe(
      'All 1 current, 1 archived, 1 on a machine that is off.',
    )
  })

  it('leads with what is wrong', () => {
    const list = [
      entry({ source: 'a', state: 'failed' }),
      entry({ source: 'b', state: 'warn' }),
      entry({ source: 'c' }),
    ]
    expect(backupSummary(list)).toBe(
      '1 failed, 1 needs a fresh copy, 1 current.',
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
