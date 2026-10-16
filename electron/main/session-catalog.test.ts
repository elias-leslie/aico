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
  it("shows Tether's display title, else the default label", () => {
    const plain = descriptor('0000000a', 1)
    expect(sessionTitle(plain)).toBe('Session 4')
    expect(sessionTitle({ ...plain, displayTitle: 'Aico — Review' })).toBe('Aico — Review')
    expect(sessionTitle({ ...plain, displayTitle: '  ' })).toBe('Session 4')
  })
})

describe('coordinator chips', () => {
  it("shows Tether's badge as it is", () => {
    const plain = descriptor('0000000c', 3)
    expect(coordinatorChip(plain)).toBeNull()
    const badge = { kind: 'child' as const, text: '↳ Personal Workspace', color: '#f0a35e' }
    expect(coordinatorChip({ ...plain, badge })).toEqual({
      text: '↳ Personal Workspace',
      color: '#f0a35e',
    })
  })

  it('drops a badge that is not well formed', () => {
    const plain = descriptor('0000000c', 3)
    const coordinator = { kind: 'coordinator' as const, text: 'Coordinator', color: 'red' }
    expect(coordinatorChip({ ...plain, badge: coordinator })).toBeNull()
    expect(
      coordinatorChip({ ...plain, badge: { ...coordinator, color: '#6fa8ff', text: ' ' } }),
    ).toBeNull()
  })
})

describe('tray labels', () => {
  const tools = [
    { slug: 'claude-code', name: 'Claude Code' },
    { slug: 'shell', name: 'Shell' },
  ]

  it("names the tool from the registry, else by Aico's built-in name, else by slug", () => {
    expect(toolDisplayName('claude-code', tools)).toBe('Claude Code')
    expect(toolDisplayName('claude-code', [{ slug: 'claude-code', name: 'Claude' }])).toBe('Claude')
    expect(toolDisplayName('pi', tools)).toBe('Pi')
    expect(toolDisplayName('codex', [])).toBe('Codex')
    expect(toolDisplayName('aider', tools)).toBe('aider')
    expect(toolDisplayName('constructor', [])).toBe('constructor')
  })

  it('tells apart sessions that share a workspace label', () => {
    const a = traySessionLabel('Personal Workspace', toolDisplayName('claude-code', tools))
    const b = traySessionLabel('Personal Workspace', toolDisplayName('shell', tools))
    expect(a).toBe('Personal Workspace · Claude Code')
    expect(b).toBe('Personal Workspace · Shell')
    expect(traySessionLabel('Shell', 'Shell')).toBe('Shell')
  })
})
