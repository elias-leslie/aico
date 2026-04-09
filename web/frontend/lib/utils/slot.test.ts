import { describe, expect, it } from 'vitest'
import type { AdHocSlot, ProjectSlot } from './slot'
import {
  getPaneId,
  getSlotBaseName,
  getSlotName,
  getSlotPanelId,
  getSlotSessionId,
  getSlotWorkingDir,
  isPaneSlot,
  type PaneSlot,
  paneToSlot,
} from './slot'

const makeProjectSlot = (overrides?: Partial<ProjectSlot>): ProjectSlot => ({
  type: 'project',
  projectId: 'proj-1',
  projectName: 'My Project',
  rootPath: '/home/user/project',
  activeMode: 'shell',
  activeSessionId: 'session-abc',
  sessionBadge: null,
  ...overrides,
})

const makeAdHocSlot = (overrides?: Partial<AdHocSlot>): AdHocSlot => ({
  type: 'adhoc',
  sessionId: 'adhoc-123',
  name: 'Ad Hoc A-Term',
  workingDir: '/tmp',
  ...overrides,
})

describe('getSlotSessionId', () => {
  it('returns activeSessionId for project slot', () => {
    const slot = makeProjectSlot({ activeSessionId: 'sess-42' })
    expect(getSlotSessionId(slot)).toBe('sess-42')
  })

  it('returns null when project slot has no active session', () => {
    const slot = makeProjectSlot({ activeSessionId: null })
    expect(getSlotSessionId(slot)).toBeNull()
  })

  it('returns sessionId for adhoc slot', () => {
    const slot = makeAdHocSlot({ sessionId: 'adhoc-99' })
    expect(getSlotSessionId(slot)).toBe('adhoc-99')
  })
})

describe('getSlotPanelId', () => {
  it('returns project-prefixed id for project slot', () => {
    const slot = makeProjectSlot({ projectId: 'p-1' })
    expect(getSlotPanelId(slot)).toBe('project-p-1')
  })

  it('returns adhoc-prefixed id for adhoc slot', () => {
    const slot = makeAdHocSlot({ sessionId: 's-2' })
    expect(getSlotPanelId(slot)).toBe('adhoc-s-2')
  })

  it('returns pane-prefixed id for pane-based slots', () => {
    const slot: PaneSlot = {
      ...makeProjectSlot({ projectId: 'p-1' }),
      paneId: 'pane-123',
    }
    expect(getSlotPanelId(slot)).toBe('pane-pane-123')
  })
})

describe('getSlotName', () => {
  it('returns project name when badge is null', () => {
    const slot = makeProjectSlot({ projectName: 'Foo', sessionBadge: null })
    expect(getSlotName(slot)).toBe('Foo')
  })

  it('returns project name when badge is 1', () => {
    const slot = makeProjectSlot({ projectName: 'Foo', sessionBadge: 1 })
    expect(getSlotName(slot)).toBe('Foo')
  })

  it('returns project name with badge when badge > 1', () => {
    const slot = makeProjectSlot({ projectName: 'Foo', sessionBadge: 3 })
    expect(getSlotName(slot)).toBe('Foo [3]')
  })

  it('returns name for adhoc slot', () => {
    const slot = makeAdHocSlot({ name: 'My A-Term' })
    expect(getSlotName(slot)).toBe('My A-Term')
  })
})

describe('getSlotBaseName', () => {
  it('returns project name without badge for project slot', () => {
    const slot = makeProjectSlot({ projectName: 'Bar', sessionBadge: 5 })
    expect(getSlotBaseName(slot)).toBe('Bar')
  })

  it('returns name for adhoc slot', () => {
    const slot = makeAdHocSlot({ name: 'A-Term X' })
    expect(getSlotBaseName(slot)).toBe('A-Term X')
  })
})

describe('getSlotWorkingDir', () => {
  it('returns rootPath for project slot', () => {
    const slot = makeProjectSlot({ rootPath: '/home/user/code' })
    expect(getSlotWorkingDir(slot)).toBe('/home/user/code')
  })

  it('returns null when project slot has no rootPath', () => {
    const slot = makeProjectSlot({ rootPath: null })
    expect(getSlotWorkingDir(slot)).toBeNull()
  })

  it('returns workingDir for adhoc slot', () => {
    const slot = makeAdHocSlot({ workingDir: '/var/log' })
    expect(getSlotWorkingDir(slot)).toBe('/var/log')
  })
})

describe('isPaneSlot', () => {
  it('returns true for slot with paneId', () => {
    const paneSlot: PaneSlot = {
      ...makeProjectSlot(),
      paneId: 'pane-1',
    }
    expect(isPaneSlot(paneSlot)).toBe(true)
  })

  it('returns false for slot without paneId', () => {
    const slot = makeProjectSlot()
    expect(isPaneSlot(slot)).toBe(false)
  })
})

describe('getPaneId', () => {
  it('returns the pane ID from a PaneSlot', () => {
    const paneSlot: PaneSlot = {
      ...makeProjectSlot(),
      paneId: 'pane-42',
    }
    expect(getPaneId(paneSlot)).toBe('pane-42')
  })
})

describe('paneToSlot', () => {
  it('converts a project pane to a PaneBasedSlot with agent state', () => {
    const slot = paneToSlot({
      id: 'pane-1',
      pane_type: 'project',
      project_id: 'proj-x',
      pane_order: 0,
      pane_name: 'A-Term',
      active_mode: 'shell',
      is_detached: false,
      created_at: null,
      width_percent: 50,
      height_percent: 100,
      grid_row: 0,
      grid_col: 0,
      sessions: [
        {
          id: 's1',
          name: 'Shell',
          mode: 'shell',
          session_number: 1,
          is_alive: true,
          working_dir: '/ws',
          claude_state: 'not_started',
        },
        {
          id: 's2',
          name: 'Agent',
          mode: 'claude',
          session_number: 2,
          is_alive: true,
          working_dir: '/ws',
          claude_state: 'running',
        },
      ],
    })

    expect(slot.type).toBe('project')
    expect(slot.paneId).toBe('pane-1')
    if (slot.type === 'project') {
      expect(slot.projectId).toBe('proj-x')
      expect(slot.activeSessionId).toBe('s1')
      expect(slot.claudeState).toBe('running')
    }
  })

  it('converts an adhoc pane to an AdHocPaneSlot', () => {
    const slot = paneToSlot({
      id: 'pane-2',
      pane_type: 'adhoc',
      project_id: null,
      pane_order: 1,
      pane_name: 'Ad-Hoc',
      active_mode: 'shell',
      is_detached: false,
      created_at: null,
      width_percent: 100,
      height_percent: 100,
      grid_row: 0,
      grid_col: 0,
      sessions: [
        {
          id: 's3',
          name: 'Shell',
          mode: 'shell',
          session_number: 1,
          is_alive: true,
          working_dir: '/tmp',
          claude_state: 'not_started',
        },
      ],
    })

    expect(slot.type).toBe('adhoc')
    expect(slot.paneId).toBe('pane-2')
    if (slot.type === 'adhoc') {
      expect(slot.sessionId).toBe('s3')
      expect(slot.name).toBe('Ad-Hoc')
      expect(slot.workingDir).toBe('/tmp')
      expect(slot.sessionMode).toBe('shell')
    }
  })
})
