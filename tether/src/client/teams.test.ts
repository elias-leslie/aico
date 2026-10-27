import { describe, expect, it } from 'vitest'
import {
  foldTeams,
  laneTitle,
  type TeamGroup,
  type TeamMember,
  teamMembers,
  teamSummary,
} from './teams'

function member(id: string, group: TeamGroup, extra: Partial<TeamMember> = {}): TeamMember {
  return { id, coordinator: false, coordinatorId: null, group, at: null, ...extra }
}

const ids = (rows: { item: { id: string } }[]) => rows.map((row) => row.item.id)

describe('foldTeams', () => {
  it('folds lanes under their coordinator and lists each session once', () => {
    const rows = foldTeams([
      member('lead', 'idle', { coordinator: true }),
      member('a', 'working', { coordinatorId: 'lead' }),
      member('b', 'finished', { coordinatorId: 'lead' }),
      member('solo', 'working'),
    ])
    expect(ids(rows)).toEqual(['lead', 'solo'])
    const lead = rows[0]
    expect(ids(lead.children)).toEqual(['a', 'b'])
    expect(
      rows
        .flatMap(teamMembers)
        .map((m) => m.id)
        .sort(),
    ).toEqual(['a', 'b', 'lead', 'solo'])
  })

  it('moves a team to Needs you only for a lane blocked on the owner', () => {
    const working = foldTeams([
      member('lead', 'idle', { coordinator: true }),
      member('a', 'working', { coordinatorId: 'lead' }),
      member('b', 'finished', { coordinatorId: 'lead' }),
    ])
    expect(working[0].group).toBe('idle')

    const blocked = foldTeams([
      member('lead', 'working', { coordinator: true }),
      member('a', 'needs-you', { coordinatorId: 'lead', at: 50 }),
      member('other', 'needs-you', { at: 10 }),
    ])
    expect(blocked.map((r) => [r.item.id, r.group])).toEqual([
      ['other', 'needs-you'],
      ['lead', 'needs-you'],
    ])
  })

  it('puts lanes that need you first and keeps the rest in arrival order', () => {
    const [lead] = foldTeams([
      member('lead', 'working', { coordinator: true }),
      member('idle', 'idle', { coordinatorId: 'lead', at: 30 }),
      member('done', 'finished', { coordinatorId: 'lead', at: 20 }),
      member('none', 'no-status', { coordinatorId: 'lead' }),
      member('busy', 'working', { coordinatorId: 'lead', at: 10 }),
      member('ask', 'needs-you', { coordinatorId: 'lead', at: 5 }),
    ])
    expect(ids(lead.children)).toEqual(['ask', 'idle', 'done', 'none', 'busy'])
    expect(lead.summary).toBe('1 working, 1 needs you, 2 idle')
  })

  it('never reorders rows for working, idle or finished changes', () => {
    const before = foldTeams([member('a', 'idle', { at: 1 }), member('b', 'working', { at: 2 })])
    const after = foldTeams([member('a', 'working', { at: 3 }), member('b', 'finished', { at: 4 })])
    expect(ids(before)).toEqual(['a', 'b'])
    expect(ids(after)).toEqual(['a', 'b'])
  })

  it('returns lanes of an ended coordinator to the top level, marked', () => {
    const rows = foldTeams([member('a', 'working', { coordinatorId: 'gone' }), member('b', 'idle')])
    expect(rows.map((r) => [r.item.id, r.orphaned])).toEqual([
      ['a', true],
      ['b', false],
    ])
  })

  it('folds a nested coordinator one level per coordinator', () => {
    const rows = foldTeams([
      member('root', 'idle', { coordinator: true }),
      member('mid', 'working', { coordinator: true, coordinatorId: 'root' }),
      member('leaf', 'needs-you', { coordinatorId: 'mid' }),
    ])
    expect(ids(rows)).toEqual(['root'])
    expect(rows[0].group).toBe('needs-you')
    expect(ids(rows[0].children)).toEqual(['mid'])
    expect(rows[0].children[0].group).toBe('needs-you')
    expect(ids(rows[0].children[0].children)).toEqual(['leaf'])
  })

  it('keeps sessions whose lineage loops at the top level', () => {
    const rows = foldTeams([
      member('a', 'idle', { coordinatorId: 'b' }),
      member('b', 'idle', { coordinatorId: 'a' }),
    ])
    expect(ids(rows).sort()).toEqual(['a', 'b'])
  })
})

describe('teamSummary', () => {
  it('has no finished count and leaves out sessions with no status', () => {
    expect(teamSummary([{ group: 'finished' }, { group: 'working' }])).toBe('1 working, 1 idle')
    expect(teamSummary([{ group: 'needs-you' }, { group: 'needs-you' }])).toBe('2 need you')
    expect(teamSummary([{ group: 'no-status' }, { group: 'no-status' }])).toBe('2 sessions')
  })
})

describe('laneTitle', () => {
  it('drops the project its coordinator already names', () => {
    expect(laneTitle('Neri — Matomo pair lead', 'Neri — Daybreak lead')).toBe('Matomo pair lead')
    expect(laneTitle('Neri — Matomo pair lead', 'Neri')).toBe('Matomo pair lead')
    expect(laneTitle('Aico — fix tray', 'Neri — Daybreak lead')).toBe('Aico — fix tray')
    expect(laneTitle('Neri', 'Neri — lead')).toBe('Neri')
  })
})
