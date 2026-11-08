import { describe, expect, it } from 'vitest'
import type { Attention } from '@/lib/attention'
import type { HistorySession } from '@/lib/history'
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

const ended = (
  id: string,
  projectId: string,
  over: Partial<HistorySession> = {},
): HistorySession => ({
  id,
  tool: 'claude-code',
  parentId: null,
  project: projectId,
  cwd: null,
  model: null,
  startedAt: NOW - 3 * HOUR,
  endedAt: NOW - 2 * HOUR,
  outcome: 'completed',
  tokens: { input: 0, cacheRead: 0, cacheWrite: 0, output: 0 },
  toolCalls: 0,
  filesWritten: 0,
  ...over,
})

const OWNED: ReadonlySet<string> = new Set()

describe('buildProjectTree', () => {
  it('puts sessions under their project, the most recently active project first', () => {
    const tree = buildProjectTree({
      teams: teams(
        [slot('aa', 'Fix quota', 'portfolio'), slot('bbb', 'Cleanup', 'aico')],
        {
          aa: group('working', NOW - 5 * HOUR),
          bbb: group('working', NOW - HOUR),
        },
      ),
      projects: [
        project('portfolio', 'Portfolio', null),
        project('aico', 'Aico', null),
      ],
      history: [],
      owned: OWNED,
      now: NOW,
    })
    expect(tree.groups.map((g) => g.name)).toEqual(['Aico', 'Portfolio'])
  })

  it('lists working sessions before idle ones inside a project', () => {
    const tree = buildProjectTree({
      teams: teams(
        [slot('aa', 'Idle one', 'aico'), slot('bbb', 'Busy one', 'aico')],
        { aa: group('idle', NOW), bbb: group('working', NOW) },
      ),
      projects: null,
      history: [],
      owned: OWNED,
      now: NOW,
    })
    expect(tree.groups[0]?.teams.map((team) => team.item.entry.label)).toEqual([
      'Busy one',
      'Idle one',
    ])
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
      history: [],
      owned: OWNED,
      now: NOW,
    })
    expect(tree.groups.map((g) => g.name)).toEqual(['Neri'])
    expect(tree.groups[0]?.teams[0]?.children).toHaveLength(1)
    // The lane's own project is quiet, not a header.
    expect(tree.quiet?.map((q) => q.name)).toEqual(['Docs'])
  })

  it('keeps finished sessions and today’s ended conversations with their project', () => {
    const tree = buildProjectTree({
      teams: teams([slot('aa', 'Live', 'aico'), slot('bbb', 'Done', 'aico')], {
        aa: group('working', NOW),
        bbb: group('finished', NOW),
      }),
      projects: null,
      history: [
        ended('h1', 'aico'),
        // Not shown: a test run, one a running session owns, yesterday's, and one with no final reply.
        ended('h2', 'aico', { test: true }),
        ended('h3', 'aico'),
        ended('h4', 'aico', { endedAt: NOW - 30 * HOUR }),
        ended('h5', 'aico', { outcome: null }),
      ],
      owned: new Set(['h3']),
      now: NOW,
    })
    const [aico] = tree.groups
    expect(aico?.teams.map((t) => t.item.entry.label)).toEqual(['Live'])
    expect(aico?.finished.map((t) => t.item.entry.label)).toEqual(['Done'])
    expect(aico?.ended.map((s) => s.id)).toEqual(['h1'])
  })

  it('folds projects with nothing running into the quiet list, archived ones left out', () => {
    const tree = buildProjectTree({
      teams: teams([slot('aa', 'Live', 'aico')], {
        aa: group('working', NOW),
      }),
      projects: [
        project('aico', 'Aico', null),
        project('old', 'Old', '2026-11-01T00:00:00Z'),
        project('new', 'New', '2026-11-07T10:00:00Z'),
        project('gone', 'Gone', null, true),
      ],
      history: [ended('h1', 'new')],
      owned: OWNED,
      now: NOW,
    })
    expect(tree.quiet?.map((q) => [q.name, q.endedToday])).toEqual([
      ['New', 1],
      ['Old', 0],
    ])
  })

  it('does not know who is quiet until the project list is read', () => {
    const tree = buildProjectTree({
      teams: teams([slot('aa', 'Live', 'aico')], { aa: group('idle', NOW) }),
      projects: null,
      history: null,
      owned: OWNED,
      now: NOW,
    })
    expect(tree.quiet).toBeNull()
    expect(tree.groups[0]?.name).toBe('aico')
  })

  it('gathers sessions with no project under one name', () => {
    const tree = buildProjectTree({
      teams: teams([slot('aa', 'Loose', null)], { aa: group('idle', NOW) }),
      projects: [],
      history: [],
      owned: OWNED,
      now: NOW,
    })
    expect(tree.groups[0]?.name).toBe(NO_PROJECT_NAME)
  })
})
