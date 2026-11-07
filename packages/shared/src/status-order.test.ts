import { describe, expect, it } from 'vitest'
import { byTier, tierLabel, tierOf } from './status-order'

const row = (id: string, kind = 'check') => ({ id, kind })

describe('tierOf', () => {
  it('names what each live row costs', () => {
    expect(tierOf(row('davion-sidarli/backup/native/home', 'backup'))).toBe('lost')
    expect(tierOf(row('davion-sidarli/check-backups'))).toBe('lost')
    expect(tierOf(row('jobs/backups-drive', 'job'))).toBe('lost')
    expect(tierOf(row('davion-sidarli/check-memory'))).toBe('lost')
    expect(tierOf(row('davion-sidarli/check-sudo'))).toBe('security')
    expect(tierOf(row('davion-sidarli/check-tripwire'))).toBe('security')
    expect(tierOf(row('ominull.detection.health'))).toBe('security')
    expect(tierOf(row('davion-sidarli/grant-79a3', 'grant'))).toBe('security')
    expect(tierOf(row('davion-sidarli/aico-web', 'service'))).toBe('service')
    expect(tierOf(row('ominull.maintenance'))).toBe('service')
    expect(tierOf(row('jobs/context-unused', 'job'))).toBe('service')
    expect(tierOf(row('davion-sidarli/check-perf'))).toBe('resource')
    expect(tierOf(row('davion-sidarli/check-storage'))).toBe('resource')
    expect(tierOf(row('usage/opencode-go'))).toBe('resource')
  })

  it('puts a row no rule names with service trouble', () => {
    expect(tierOf(row('portfolio-ai/worker', 'service'))).toBe('service')
    expect(tierOf(row('something/new', 'link'))).toBe('service')
  })
})

describe('byTier', () => {
  it('orders a mixed list: lost work, security, service, then swap and disk', () => {
    const mixed = [
      row('davion-sidarli/check-perf'),
      row('usage/opencode-go'),
      row('ominull.maintenance'),
      row('davion-sidarli/check-sudo'),
      row('portfolio-ai/worker', 'service'),
      row('davion-sidarli/check-memory'),
      row('ominull.detection.health'),
      row('davion-sidarli/check-storage'),
      row('davion-sidarli/backup/drive/aico', 'backup'),
    ]
    expect([...mixed].sort(byTier).map((item) => item.id)).toEqual([
      'davion-sidarli/check-memory',
      'davion-sidarli/backup/drive/aico',
      'davion-sidarli/check-sudo',
      'ominull.detection.health',
      'ominull.maintenance',
      'portfolio-ai/worker',
      'davion-sidarli/check-perf',
      'usage/opencode-go',
      'davion-sidarli/check-storage',
    ])
  })
})

describe('tierLabel', () => {
  it('reads in plain words', () => {
    expect(tierLabel('lost')).toBe('Lost work')
    expect(tierLabel('resource')).toBe('Speed and space')
  })
})
