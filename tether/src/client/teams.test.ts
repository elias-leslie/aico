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
    const parents = foldTeams([
      member('root', 'idle', { coordinator: true }),
      member('a', 'idle', { coordinatorId: 'root', parentId: 'b' }),
      member('b', 'idle', { coordinatorId: 'root', parentId: 'a' }),
    ])
    expect(
      parents
        .flatMap(teamMembers)
        .map((m) => m.id)
        .sort(),
    ).toEqual(['a', 'b', 'root'])
  })

  it('nests each lane under the lane that launched it, three deep', () => {
    const rows = foldTeams([
      member('root', 'idle', { coordinator: true }),
      member('lane', 'working', { coordinatorId: 'root', parentId: 'root' }),
      member('helper', 'working', { coordinatorId: 'root', parentId: 'lane' }),
      member('hunter', 'needs-you', { coordinatorId: 'root', parentId: 'helper' }),
      member('flat', 'idle', { coordinatorId: 'root' }),
    ])
    expect(ids(rows)).toEqual(['root'])
    const [root] = rows
    expect(ids(root.children)).toEqual(['lane', 'flat'])
    const [lane] = root.children
    expect(ids(lane.children)).toEqual(['helper'])
    expect(ids(lane.children[0].children)).toEqual(['hunter'])
    // A wait three levels down lifts every level, and summaries count the whole team.
    expect([root.group, lane.group]).toEqual(['needs-you', 'needs-you'])
    expect(root.summary).toBe('2 working, 1 needs you, 1 idle')
    expect(lane.summary).toBe('1 working, 1 needs you')
  })

  it('falls back to the coordinator when the launcher is not listed', () => {
    const rows = foldTeams([
      member('root', 'idle', { coordinator: true }),
      member('helper', 'working', { coordinatorId: 'root', parentId: 'ended' }),
      member('stray', 'working', { coordinatorId: 'gone', parentId: 'also-gone' }),
    ])
    expect(ids(rows)).toEqual(['root', 'stray'])
    expect(ids(rows[0].children)).toEqual(['helper'])
    expect(rows[0].children[0].orphaned).toBe(false)
    expect(rows[1].orphaned).toBe(true)
  })

  it('nests under a listed launcher after the coordinator ended, unmarked', () => {
    const rows = foldTeams([
      member('lane', 'working', { coordinatorId: 'ended', parentId: 'ended' }),
      member('helper', 'working', { coordinatorId: 'ended', parentId: 'lane' }),
    ])
    expect(ids(rows)).toEqual(['lane'])
    expect(rows[0].orphaned).toBe(true)
    expect(rows[0].children[0].orphaned).toBe(false)
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
