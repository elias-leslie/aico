import { describe, expect, it } from 'vitest'
import {
  coordinatorChip,
  createSessionCatalog,
  sessionTitle,
  toolDisplayName,
  traySessionLabel,
} from './session-catalog'
import type { SessionDescriptor } from './tether-client'

function descriptor(id: string, createdAt: number, extra: Partial<SessionDescriptor> = {}) {
  return {
    id,
    ownershipId: `aico-widget-${id}`,
    generation: 'a'.repeat(64),
    status: 'running',
    available: true,
    tool: 'codex',
    name: null,
    label: 'Session 4',
    projectId: null,
    projectRoot: null,
    origin: 'aico',
    rootRequestId: null,
    lifecycleVersion: 1,
    tmux: {
      serverId: null,
      socket: null,
      sessionId: '$1',
      paneId: '%1',
      sessionName: `aico-${id}`,
    },
    createdAt,
    ...extra,
  } as SessionDescriptor
}

describe('session catalog mirror', () => {
  it('reports sessions that left a complete list and orders oldest first', () => {
    const catalog = createSessionCatalog()
    catalog.replace([descriptor('0000000b', 2), descriptor('0000000a', 1)])
    expect(catalog.list().map((d) => d.id)).toEqual(['0000000a', '0000000b'])
    expect(catalog.replace([descriptor('0000000b', 2), descriptor('0000000c', 3)])).toEqual({
      gone: ['0000000a'],
    })
    catalog.remove('0000000b')
    expect(catalog.get('0000000b')).toBeUndefined()
  })

  it('keeps a session created locally while an older list was in flight', () => {
    const catalog = createSessionCatalog()
    catalog.replace([descriptor('0000000a', 1)])
    const mark = catalog.mark()
    catalog.upsert(descriptor('0000000c', 3)) // created after the list request
    expect(catalog.replace([descriptor('0000000a', 1)], mark)).toEqual({ gone: [] })
    expect(catalog.get('0000000c')).toBeDefined()
    // A later complete list that still lacks it does report it gone.
    expect(catalog.replace([descriptor('0000000a', 1)], catalog.mark())).toEqual({
      gone: ['0000000c'],
    })
  })
})

describe('session titles', () => {
  const projects = {
    nameFor: (id: string | null, root: string | null) =>
      id === 'aico' ? 'Aico' : root === '/personal' ? 'Personal Workspace' : null,
  }

  it('composes Project — Task, else either part, else the default label', () => {
    const plain = descriptor('0000000a', 1)
    expect(sessionTitle(plain, projects)).toBe('Session 4')
    expect(sessionTitle({ ...plain, projectId: 'aico' }, projects)).toBe('Aico')
    expect(sessionTitle({ ...plain, projectRoot: '/personal' }, projects)).toBe(
      'Personal Workspace',
    )
    expect(sessionTitle({ ...plain, projectId: 'aico', name: ' Review ' }, projects)).toBe(
      'Aico — Review',
    )
    expect(sessionTitle({ ...plain, name: 'Review' }, projects)).toBe('Review')
    expect(sessionTitle({ ...plain, projectId: 'aico', name: '   ' }, projects)).toBe('Aico')
  })

  it('drops a task that repeats the project name', () => {
    const plain = { ...descriptor('0000000a', 1), projectRoot: '/personal' }
    expect(sessionTitle({ ...plain, name: 'personal workspace' }, projects)).toBe(
      'Personal Workspace',
    )
  })
})

describe('coordinator chips', () => {
  const projects = {
    nameFor: (id: string | null) => (id === 'aico' ? 'Aico' : id === 'a-term' ? 'A-Term' : null),
  }
  const lead = { ...descriptor('0000000a', 1), projectId: 'a-term', name: 'Session badges' }
  const sessions = new Map<string, SessionDescriptor>([[lead.id, lead as SessionDescriptor]])
  const lookup = (id: string) => sessions.get(id)

  it('labels a coordinator and its lanes in the coordinator colour', () => {
    expect(
      coordinatorChip(
        { ...lead, coordinator: true, coordinatorColor: '#f0a35e' },
        lookup,
        projects,
      ),
    ).toEqual({ text: 'Coordinator', color: '#f0a35e' })
    const lane = {
      ...descriptor('0000000b', 2),
      projectId: 'aico',
      coordinatorId: lead.id,
      coordinatorColor: '#f0a35e',
    }
    expect(coordinatorChip(lane, lookup, projects)).toEqual({
      text: '↳ Session badges',
      color: '#f0a35e',
    })
  })

  it("names the lane's coordinator by its task, else its project, else Coordinator", () => {
    const lane = { ...descriptor('0000000b', 2), coordinatorId: lead.id }
    sessions.set(lead.id, { ...lead, name: 'a-term' })
    expect(coordinatorChip(lane, lookup, projects)?.text).toBe('↳ A-Term')
    sessions.set(lead.id, { ...lead, name: null, projectId: null })
    expect(coordinatorChip(lane, lookup, projects)?.text).toBe('↳ Coordinator')
    expect(coordinatorChip({ ...lane, coordinatorId: 'ffffffff' }, lookup, projects)?.text).toBe(
      '↳ Coordinator',
    )
  })

  it('falls back to the default colour and shows nothing for other sessions', () => {
    const plain = descriptor('0000000c', 3)
    expect(coordinatorChip(plain, lookup, projects)).toBeNull()
    expect(coordinatorChip({ ...plain, coordinator: true }, lookup, projects)?.color).toBe(
      '#6fa8ff',
    )
    expect(
      coordinatorChip({ ...plain, coordinator: true, coordinatorColor: 'red' }, lookup, projects)
        ?.color,
    ).toBe('#6fa8ff')
  })
})

describe('tray labels', () => {
  const tools = [
    { slug: 'claude-code', name: 'Claude Code' },
    { slug: 'shell', name: 'Shell' },
  ]

  it('names the tool from the registry, else by slug', () => {
    expect(toolDisplayName('claude-code', tools)).toBe('Claude Code')
    expect(toolDisplayName('pi', tools)).toBe('pi')
  })

  it('tells apart sessions that share a workspace label', () => {
    const a = traySessionLabel('Personal Workspace', toolDisplayName('claude-code', tools))
    const b = traySessionLabel('Personal Workspace', toolDisplayName('shell', tools))
    expect(a).toBe('Personal Workspace · Claude Code')
    expect(b).toBe('Personal Workspace · Shell')
    expect(traySessionLabel('Shell', 'Shell')).toBe('Shell')
  })
})
