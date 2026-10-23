import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { Store } from '../store'
import {
  bindCatalog,
  COORDINATOR_COLORS,
  getWidget,
  insertWidget,
  recordLauncher,
  setWidgetName,
  setWidgetProject,
  type WidgetRow,
} from './catalog'
import {
  badge,
  displayTitle,
  FALLBACK_BADGE_COLOR,
  rememberProjects,
  setPersonalWorkspaceRoot,
} from './display'

const store = new Store(':memory:')
const PERSONAL = '/home/test/.local/share/aico/personal-workspace'

beforeAll(() => {
  bindCatalog(store.db)
  setPersonalWorkspaceRoot(PERSONAL)
  rememberProjects([
    { id: 'summitflow', name: 'SummitFlow', root: '/srv/summitflow', lifecycle: null },
    { id: 'a-term', name: 'A-Term', root: '/srv/a-term', lifecycle: null },
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
    setWidgetProject('d0000001', null, '/srv/a-term')
    expect(displayTitle(row('d0000001'))).toBe('A-Term — summitflow')
    setWidgetProject('d0000001', null, PERSONAL)
    setWidgetName('d0000001', null)
    expect(displayTitle(row('d0000001'))).toBe('Personal Workspace')
  })

  it('reports whether project names changed', () => {
    const same = [
      { id: 'summitflow', name: 'SummitFlow', root: '/srv/summitflow', lifecycle: null },
      { id: 'a-term', name: 'A-Term', root: '/srv/a-term', lifecycle: null },
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
