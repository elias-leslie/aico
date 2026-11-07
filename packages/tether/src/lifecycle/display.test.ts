import { Store } from '@aico/session-engine/store'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  bindCatalog,
  COORDINATOR_COLORS,
  getWidget,
  insertWidget,
  recordLauncher,
  reserveRootRequest,
  setWidgetName,
  setWidgetProject,
  type WidgetRow,
} from './catalog'
import {
  autoName,
  badge,
  displayTitle,
  FALLBACK_BADGE_COLOR,
  rememberProjects,
  setPersonalWorkspaceRoot,
  taskName,
  useConversationNames,
} from './display'

const store = new Store(':memory:')
const PERSONAL = '/home/test/.local/share/aico/personal-workspace'

beforeAll(() => {
  bindCatalog(store.db)
  setPersonalWorkspaceRoot(PERSONAL)
  rememberProjects([
    { id: 'summitflow', name: 'SummitFlow', root: '/srv/summitflow', lifecycle: null },
    { id: 'agent-hub', name: 'Agent Hub', root: '/srv/agent-hub', lifecycle: null },
  ])
})
afterAll(() => store.close())

function row(id: string): WidgetRow {
  const found = getWidget(id)
  if (!found) throw new Error(`missing test widget ${id}`)
  return found
}

describe('display title', () => {
  it('reads Project — Task, either alone, else the session number', () => {
    insertWidget('d0000001', 'codex')
    expect(displayTitle(row('d0000001'))).toMatch(/^Session \d+$/)
    setWidgetName('d0000001', ' Browser move ')
    expect(displayTitle(row('d0000001'))).toBe('Browser move')
    setWidgetProject('d0000001', 'summitflow', '/srv/summitflow')
    expect(displayTitle(row('d0000001'))).toBe('SummitFlow — Browser move')
    // A task that only repeats the project collapses; roots name projects too.
    setWidgetName('d0000001', 'summitflow')
    setWidgetProject('d0000001', null, '/srv/agent-hub')
    expect(displayTitle(row('d0000001'))).toBe('Agent Hub — summitflow')
    setWidgetProject('d0000001', null, PERSONAL)
    setWidgetName('d0000001', null)
    expect(displayTitle(row('d0000001'))).toBe('Personal Workspace')
  })

  it('names an unnamed session by the name its tool gives the conversation, else its first prompt, never over a typed name', () => {
    insertWidget('d0000009', 'claude-code')
    setWidgetProject('d0000009', 'summitflow', '/srv/summitflow')
    const names = new Map<
      string,
      { title: string | null; prompt: string | null; doing: string | null }
    >()
    useConversationNames((id) => names.get(id))
    expect(displayTitle(row('d0000009'))).toBe('SummitFlow')
    names.set('d0000009', { title: null, prompt: 'Fix the login form', doing: null })
    expect(displayTitle(row('d0000009'))).toBe('SummitFlow — Fix the login form')
    expect(autoName('d0000009')).toBe('Fix the login form')
    names.set('d0000009', { title: 'Login form fix', prompt: 'Fix the login form', doing: null })
    expect(displayTitle(row('d0000009'))).toBe('SummitFlow — Login form fix')
    expect(taskName(row('d0000009'))).toBe('Login form fix')
    setWidgetName('d0000009', 'ux-test')
    expect(displayTitle(row('d0000009'))).toBe('SummitFlow — ux-test')
    // A project prefix typed into the name is not shown twice.
    setWidgetName('d0000009', 'SummitFlow — ux-test')
    expect(displayTitle(row('d0000009'))).toBe('SummitFlow — ux-test')
    useConversationNames(() => undefined)
  })

  it('names an untitled root by its work-role name, else its request ID', () => {
    const root = (requestId: string, widgetId: string, workRoleDisplayName: string | null) =>
      reserveRootRequest(
        {
          requestId,
          digest: 'd'.repeat(64),
          widgetId,
          logicalSessionId: `logical-${widgetId}`,
          role: 'portfolio-root',
          workRole: 'implementation',
          workRoleDisplayName,
          leadRootReference: null,
          facetCapsuleRef: null,
          createdAt: Date.now(),
          origin: 'aico',
        },
        'pi',
        'agent-hub',
        '/srv/agent-hub',
      )
    root('rh-14', 'd0000010', null)
    root('rh-15', 'd0000011', ' Files lane ')
    expect(displayTitle(row('d0000010'))).toBe('Agent Hub — rh-14')
    expect(displayTitle(row('d0000011'))).toBe('Agent Hub — Files lane')
    // A title set later wins.
    setWidgetName('d0000010', 'Session files')
    expect(displayTitle(row('d0000010'))).toBe('Agent Hub — Session files')
  })

  it('reports whether project names changed', () => {
    const same = [
      { id: 'summitflow', name: 'SummitFlow', root: '/srv/summitflow', lifecycle: null },
      { id: 'agent-hub', name: 'Agent Hub', root: '/srv/agent-hub', lifecycle: null },
    ]
    expect(rememberProjects(same)).toBe(false)
    expect(rememberProjects([{ ...same[0], name: 'Summit' }, same[1]])).toBe(true)
    expect(rememberProjects(same)).toBe(true)
  })
})

describe('badge', () => {
  it('marks coordinators and names a lane’s root coordinator in its colour', () => {
    for (const id of ['d0000002', 'd0000003', 'd0000004', 'd0000005']) insertWidget(id, 'codex')
    setWidgetProject('d0000002', null, PERSONAL)
    recordLauncher('d0000003', 'd0000002')
    recordLauncher('d0000004', 'd0000003')
    const color = row('d0000002').coordinatorColor ?? ''
    expect(COORDINATOR_COLORS).toContain(color)
    expect(badge(row('d0000002'))).toEqual({ kind: 'coordinator', text: 'Coordinator', color })
    const lane = { kind: 'child', text: '↳ Personal Workspace', color }
    expect(badge(row('d0000003'))).toEqual(lane)
    expect(badge(row('d0000004'))).toEqual(lane)
    // The coordinator's task, when it has one, names it.
    setWidgetName('d0000002', 'Release train')
    expect(badge(row('d0000004'))?.text).toBe('↳ Release train')
    expect(badge(row('d0000005'))).toBeNull()
  })

  it('falls back when the coordinator ended or predates colours', () => {
    insertWidget('d0000006', 'codex')
    store.db
      .prepare('UPDATE sessions SET coordinator_id = ?, coordinator_color = NULL WHERE id = ?')
      .run('deadbeef', 'd0000006')
    expect(badge(row('d0000006'))).toEqual({
      kind: 'child',
      text: '↳ Coordinator',
      color: FALLBACK_BADGE_COLOR,
    })
  })
})
