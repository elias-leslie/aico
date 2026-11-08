import { describe, expect, it } from 'vitest'
import {
  type Entry,
  eventLine,
  labPath,
  metaTip,
  shownName,
  sourceLabel,
} from './logins'

const entry = (over: Partial<Entry> = {}): Entry => ({
  name: 'github-token',
  kind: 'API key',
  notes: '',
  state: 'In use',
  machines: [],
  roles: [],
  created: '2026-11-01T00:00:00Z',
  rotated: null,
  lastUsed: null,
  ...over,
})
const lab = (target: string, actor: string, username?: string) =>
  entry({
    name: `_lab_${target}--${actor}`,
    kind: 'lab login',
    lab: {
      target,
      actor,
      kind: 'account',
      fields: [],
      expires_at: null,
      username,
    },
  })

describe('how a login is named', () => {
  it('names a plain login itself and a lab login by its site', () => {
    expect(shownName(entry())).toBe('github-token')
    expect(shownName(lab('school.example', 'default'))).toBe('school.example')
  })

  it('tells several logins of one site apart by username, else by the end of the name', () => {
    const one = lab('school.example', 'default', 'parent.one')
    const two = lab('school.example', 'second')
    const alone = lab('library.example', 'default', 'reader')
    const all = [one, two, alone, entry()]
    expect(sourceLabel(one, all)).toBe('school.example · parent.one')
    expect(sourceLabel(two, all)).toBe('school.example · second')
    expect(sourceLabel(alone, all)).toBe('library.example')
    expect(sourceLabel(entry(), all)).toBe('github-token')
  })

  it('reaches a lab login at its site and actor', () => {
    expect(labPath(lab('school.example', 'second'))).toBe(
      '/api/logins/lab/school.example/second',
    )
  })

  it('says whose login a lab row is', () => {
    expect(metaTip(entry())).toBeUndefined()
    expect(metaTip(lab('school.example', 'default'))).toContain('default user')
  })
})

describe('an activity line', () => {
  const at = '2026-11-08T09:00:00Z'
  it('shows a lab login as its row names it, plain action words and the session by name', () => {
    const line = eventLine(
      {
        at,
        action: 'rotate',
        name: '_lab_school.example--second',
        actor: 's1',
      },
      true,
      [{ id: 's1', label: 'Backups lane' }],
    )
    expect(line).toContain('changed · school.example · second · Backups lane')
    expect(
      eventLine({
        at,
        action: 'set',
        name: '_lab_school.example--default',
        actor: 'owner',
      }),
    ).toContain('added · school.example · owner')
  })

  it('leaves the name out inside a login’s own panel', () => {
    expect(
      eventLine(
        { at, action: 'set', name: 'github-token', actor: 'owner' },
        false,
      ),
    ).not.toContain('github-token')
  })
})
