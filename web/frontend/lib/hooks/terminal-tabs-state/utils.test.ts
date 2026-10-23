import { describe, expect, it } from 'vitest'
import type { TerminalPane } from '@/lib/hooks/terminal-panes-types'
import type { TerminalSession } from '@/lib/hooks/use-terminal-sessions'
import { TETHER_CAN } from '@/test-stubs/session-fixtures'
import { buildSessionSlots, getActiveSessionProjectId } from './utils'

function session(
  id: string,
  extra: Partial<TerminalSession> = {},
): TerminalSession {
  return {
    id,
    name: id,
    user_id: null,
    project_id: 'project-a',
    working_dir: '/workspace/project-a',
    mode: 'shell',
    display_order: 0,
    is_alive: true,
    created_at: null,
    last_accessed_at: null,
    ...TETHER_CAN,
    ...extra,
  } as TerminalSession
}

const pane = {
  id: 'pane-a',
  pane_type: 'project',
  project_id: 'project-a',
  pane_order: 0,
  pane_name: 'Project A',
  active_mode: 'shell',
  created_at: null,
  sessions: [
    {
      id: 'in-pane',
      name: 'Project A Shell',
      mode: 'shell',
      ...TETHER_CAN,
      session_number: 1,
      is_alive: true,
      working_dir: '/workspace/project-a',
      claude_state: 'not_started',
    },
  ],
  width_percent: 100,
  height_percent: 100,
  grid_row: 0,
  grid_col: 0,
} as unknown as TerminalPane

describe('terminal-tabs-state utils', () => {
  it('lists panes first, then each session no pane shows, once', () => {
    const slots = buildSessionSlots(
      [pane],
      [
        session('in-pane'),
        session('free', { is_external: true }),
        session('unloaded', { project_id: null }),
      ],
      new Map([['project-a', 'Project A']]),
    )

    expect(slots).toHaveLength(3)
    expect(slots.slice(1).map((slot) => slot.slotId)).toEqual([
      'session-free',
      'session-unloaded',
    ])
    expect(slots[0]).toMatchObject({ paneId: 'pane-a' })
    expect(slots[1]).toMatchObject({
      type: 'project',
      projectName: 'Project A · free',
    })
    expect(slots[2]).toMatchObject({ type: 'adhoc' })
  })

  it("finds the active session's project", () => {
    const sessions = [session('a'), session('b', { project_id: null })]
    expect(getActiveSessionProjectId('a', sessions)).toBe('project-a')
    expect(getActiveSessionProjectId('b', sessions)).toBeUndefined()
    expect(getActiveSessionProjectId(null, sessions)).toBeUndefined()
  })
})
