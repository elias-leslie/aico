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
  return { id, coordinator: false, coordinatorId: null, group, ...extra }
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

  it('marks a team Needs you only for a lane blocked on the owner', () => {
    const working = foldTeams([
      member('lead', 'idle', { coordinator: true }),
      member('a', 'working', { coordinatorId: 'lead' }),
      member('b', 'finished', { coordinatorId: 'lead' }),
    ])
    expect(working[0].group).toBe('idle')

    const blocked = foldTeams([
      member('lead', 'working', { coordinator: true }),
      member('a', 'needs-you', { coordinatorId: 'lead' }),
      member('other', 'needs-you'),
    ])
    expect(blocked.map((r) => [r.item.id, r.group])).toEqual([
      ['lead', 'needs-you'],
      ['other', 'needs-you'],
    ])
  })

  it('keeps lanes in arrival order whatever their state', () => {
    const [lead] = foldTeams([
      member('lead', 'working', { coordinator: true }),
      member('idle', 'idle', { coordinatorId: 'lead' }),
      member('done', 'finished', { coordinatorId: 'lead' }),
      member('none', 'no-status', { coordinatorId: 'lead' }),
      member('busy', 'working', { coordinatorId: 'lead' }),
      member('ask', 'needs-you', { coordinatorId: 'lead' }),
    ])
    expect(ids(lead.children)).toEqual(['idle', 'done', 'none', 'busy', 'ask'])
    expect(lead.summary).toBe('1 working, 1 needs you, 2 idle')
  })

  it('never reorders rows when a state changes, Needs you included', () => {
    const before = foldTeams([member('a', 'idle'), member('b', 'working'), member('c', 'idle')])
    const after = foldTeams([
      member('a', 'working'),
      member('b', 'finished'),
      member('c', 'needs-you'),
    ])
    expect(ids(before)).toEqual(['a', 'b', 'c'])
    expect(ids(after)).toEqual(['a', 'b', 'c'])
  })

  it('keeps a team in place when one of its lanes starts waiting', () => {
    const list = (lane: TeamGroup) =>
      foldTeams([
        member('solo', 'idle'),
        member('lead', 'working', { coordinator: true }),
        member('first', 'working', { coordinatorId: 'lead' }),
        member('second', lane, { coordinatorId: 'lead' }),
      ])
    const [, lead] = list('needs-you')
    expect(ids(list('needs-you'))).toEqual(ids(list('working')))
    expect(lead.group).toBe('needs-you')
    expect(ids(lead.children)).toEqual(['first', 'second'])
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
