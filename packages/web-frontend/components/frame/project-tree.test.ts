import { describe, expect, it } from 'vitest'
import type { Attention } from '@/lib/attention'
import type { ProjectSummary } from '@/lib/projects'
import type { AdHocSlot } from '@/lib/utils/slot'
import { SLOT_BASE } from '@/test-stubs/session-fixtures'
import { buildProjectTree, NO_PROJECT_NAME } from './project-tree'
import { foldSessionEntries, sortSessionEntries } from './session-entries'

const NOW = new Date('2026-11-07T15:00:00').getTime()
const HOUR = 3_600_000

function slot(
  id: string,
  name: string,
  projectKey: string | null,
  extra: Partial<AdHocSlot> = {},
): AdHocSlot {
  return {
    ...SLOT_BASE,
    createdAt: `2026-11-07T00:00:0${id.length}Z`,
    type: 'adhoc',
    sessionId: id,
    name,
    workingDir: null,
    sessionMode: 'claude-code',
    projectKey,
    ...extra,
  }
}

const group = (state: Attention['group'], at: number): Attention => ({
  group: state,
  activity: state === 'working' ? 'working' : 'idle',
  at,
  detail: null,
  age: '1m',
})

function teams(slots: AdHocSlot[], states: Record<string, Attention>) {
  const attention = {
    forSlot: (s: unknown) => states[(s as AdHocSlot).sessionId] ?? null,
    asksFor: () => ({ blocking: 0, other: 0 }),
    needsYouCount: 0,
    waitingNoAsk: 0,
  }
  return foldSessionEntries(sortSessionEntries(slots, attention))
}

const project = (
  id: string,
  name: string,
  lastActivity: string | null,
  archived = false,
): ProjectSummary => ({
  id,
  name,
  archived,
  top: null,
  waiting: null,
  runState: null,
  problems: [],
  agents: 0,
  lastActivity,
})

describe('buildProjectTree', () => {
  it('lists projects by name, whichever was active last', () => {
    const tree = buildProjectTree({
      teams: teams(
        [
          slot('aa', 'Fix quota', 'portfolio'),
          slot('bbb', 'Cleanup', 'aico'),
          slot('cccc', 'New one', 'dadbot'),
        ],
        {
          aa: group('working', NOW - 5 * HOUR),
          bbb: group('working', NOW - HOUR),
          cccc: group('working', NOW),
        },
      ),
      projects: [
        project('portfolio', 'Portfolio', '2026-11-07T14:00:00Z'),
        project('aico', 'Aico', null),
        project('dadbot', 'Dadbot', null),
      ],
    })
    expect(tree.groups.map((g) => g.name)).toEqual([
      'Aico',
      'Dadbot',
      'Portfolio',
    ])
  })

  it('keeps sessions oldest first inside a project, whatever their state', () => {
    const tree = buildProjectTree({
      teams: teams(
        [slot('aa', 'Idle one', 'aico'), slot('bbb', 'Busy one', 'aico')],
        { aa: group('idle', NOW), bbb: group('working', NOW) },
      ),
      projects: null,
    })
    expect(tree.groups[0]?.teams.map((team) => team.item.entry.label)).toEqual([
      'Idle one',
      'Busy one',
    ])
  })

  it('keeps a session in place when it starts needing the owner', () => {
    const slots = [
      slot('aa', 'First', 'aico'),
      slot('bbb', 'Second', 'aico'),
      slot('cccc', 'Third', 'aico'),
    ]
    const labels = (third: Attention['group']) =>
      buildProjectTree({
        teams: teams(slots, {
          aa: group('working', NOW),
          bbb: group('idle', NOW),
          cccc: group(third, NOW),
        }),
        projects: null,
      }).groups[0]?.teams.map((team) => team.item.entry.label)
    expect(labels('working')).toEqual(['First', 'Second', 'Third'])
    expect(labels('needs-you')).toEqual(['First', 'Second', 'Third'])
  })

  it('keeps a project in place when it gains a waiting session', () => {
    const slots = [slot('aa', 'One', 'aico'), slot('bbb', 'Two', 'neri')]
    const names = (neri: Attention['group']) =>
      buildProjectTree({
        teams: teams(slots, {
          aa: group('working', NOW),
          bbb: group(neri, NOW),
        }),
        projects: [
          project('aico', 'Aico', null),
          project('neri', 'Neri', null),
        ],
      }).groups.map((g) => g.name)
    expect(names('idle')).toEqual(['Aico', 'Neri'])
    expect(names('needs-you')).toEqual(['Aico', 'Neri'])
  })

  it('nests a lane under its coordinator and does not list it under its own project', () => {
    const tree = buildProjectTree({
      teams: teams(
        [
          slot('lead', 'Neri lead', 'neri', { coordinator: true }),
          slot('lane', 'Docs lane', 'docs', { coordinatorId: 'lead' }),
        ],
        { lead: group('working', NOW), lane: group('working', NOW) },
      ),
      projects: [project('neri', 'Neri', null), project('docs', 'Docs', null)],
    })
    expect(tree.groups.map((g) => g.name)).toEqual(['Neri'])
    expect(tree.groups[0]?.teams[0]?.children).toHaveLength(1)
    // The lane's own project is quiet, not a header.
    expect(tree.quiet?.map((q) => q.name)).toEqual(['Docs'])
  })

  it('keeps a finished session that is still open as an ordinary row in its place', () => {
    const tree = buildProjectTree({
      teams: teams(
        [
          slot('aa', 'Done', 'aico'),
          slot('bbb', 'Live', 'aico'),
          slot('cccc', 'Done too', 'docs'),
        ],
        {
          aa: group('finished', NOW),
          bbb: group('working', NOW),
          cccc: group('finished', NOW),
        },
      ),
      projects: null,
    })
    expect(
      tree.groups.map((g) => g.teams.map((t) => t.item.entry.label)),
    ).toEqual([['Done', 'Live'], ['Done too']])
  })

  it('folds projects with nothing running into the quiet list, archived ones left out', () => {
    const tree = buildProjectTree({
      teams: teams([slot('aa', 'Live', 'aico')], {
        aa: group('working', NOW),
      }),
      projects: [
        project('aico', 'Aico', null),
        project('old', 'Old', '2026-11-07T10:00:00Z'),
        project('new', 'New', '2026-11-01T00:00:00Z'),
        project('gone', 'Gone', null, true),
      ],
    })
    expect(tree.quiet?.map((q) => q.name)).toEqual(['New', 'Old'])
  })

  it('does not know who is quiet until the project list is read', () => {
    const tree = buildProjectTree({
      teams: teams([slot('aa', 'Live', 'aico')], { aa: group('idle', NOW) }),
      projects: null,
    })
    expect(tree.quiet).toBeNull()
    expect(tree.groups[0]?.name).toBe('aico')
  })

  it('gathers sessions with no project under one name', () => {
    const tree = buildProjectTree({
      teams: teams([slot('aa', 'Loose', null)], { aa: group('idle', NOW) }),
      projects: [],
    })
    expect(tree.groups[0]?.name).toBe(NO_PROJECT_NAME)
  })
})
