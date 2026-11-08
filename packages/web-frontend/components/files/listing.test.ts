import { describe, expect, it } from 'vitest'
import { defaultSort, modifiedLabel } from './listing'

const now = new Date('2026-11-07T12:00:00').getTime()
const places = [
  { id: 'home', label: 'Home', path: '/home/me' },
  { id: '/tmp', label: '/tmp', path: '/tmp' },
]

describe('modifiedLabel', () => {
  it('says minutes and hours ago for today, then the day', () => {
    expect(modifiedLabel(now - 20_000, now)).toBe('just now')
    expect(modifiedLabel(now - 4 * 60_000, now)).toBe('4 min ago')
    expect(modifiedLabel(now - 3 * 3_600_000, now)).toBe('3 h ago')
    expect(
      modifiedLabel(new Date('2026-11-05T09:00:00').getTime(), now),
    ).toMatch(/Nov\s*5/)
    expect(
      modifiedLabel(new Date('2025-02-03T09:00:00').getTime(), now),
    ).toMatch(/2025/)
  })
})

describe('defaultSort', () => {
  it('is Modified in Home and scratch folders, Name in a project and elsewhere', () => {
    expect(defaultSort('/tmp', places, null)).toBe('modified')
    expect(defaultSort('/tmp/agent/out', places, null)).toBe('modified')
    expect(defaultSort('/home/me', places, '/srv/work')).toBe('modified')
    expect(defaultSort('/srv/work/src', places, '/srv/work')).toBe('name')
    expect(defaultSort('/home/me/code/app', places, '/home/me/code/app')).toBe(
      'name',
    )
    expect(defaultSort('/srv', places, null)).toBe('name')
    expect(defaultSort('/tmpfoo', places, null)).toBe('name')
    expect(defaultSort('/tmp', undefined, null)).toBe('name')
  })
})
