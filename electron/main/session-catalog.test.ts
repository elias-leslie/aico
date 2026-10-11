import { describe, expect, it } from 'vitest'
import {
  createSessionCatalog,
  sessionLabel,
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

describe('session labels', () => {
  const projects = {
    nameFor: (id: string | null, root: string | null) =>
      id === 'aico' ? 'Aico' : root === '/personal' ? 'Personal Workspace' : null,
  }

  it('prefers a local override, then the Tether name, then the workspace, then the default', () => {
    const plain = descriptor('0000000a', 1)
    expect(sessionLabel(plain, undefined, projects)).toBe('Session 4')
    expect(sessionLabel({ ...plain, projectId: 'aico' }, undefined, projects)).toBe('Aico')
    expect(sessionLabel({ ...plain, projectRoot: '/personal' }, undefined, projects)).toBe(
      'Personal Workspace',
    )
    expect(sessionLabel({ ...plain, projectId: 'aico', name: 'Review' }, undefined, projects)).toBe(
      'Review',
    )
    expect(sessionLabel({ ...plain, name: 'Review' }, { nameOverride: 'Local' }, projects)).toBe(
      'Local',
    )
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
