import { describe, expect, it, vi } from 'vitest'
import type { ProjectInfo } from './project'
import {
  attachedATermLabel,
  enrichATermSessions,
  openableWidgetLabel,
  openableWidgetProject,
} from './session-catalog'

const projects: ProjectInfo[] = [
  { id: 'registered', name: 'Agent Hub', root: '/srv/agent-hub', current: false },
]
const live = [
  {
    session: 'summitflow-123e4567-e89b-12d3-a456-426614174000',
    label: 'A-Term 123e4567',
    cwd: '/srv/agent-hub',
  },
  {
    session: 'summitflow-123e4567-e89b-12d3-a456-426614174001',
    label: 'A-Term 123e4567',
    cwd: '/home/me',
  },
]

function response(items: unknown): Response {
  return { ok: true, json: async () => ({ items }) } as Response
}

describe('session catalog labels', () => {
  it('joins active and detached pane metadata by exact live tmux session ID', async () => {
    const fetchFn = vi.fn(async (url: string) =>
      response(
        url.endsWith('/detached')
          ? [
              {
                pane_type: 'adhoc',
                project_id: null,
                pane_name: 'Scratchpad',
                sessions: [
                  { id: '123e4567-e89b-12d3-a456-426614174001', mode: 'shell', is_alive: true },
                  { id: '123e4567-e89b-12d3-a456-426614174099', mode: 'shell', is_alive: true },
                ],
              },
            ]
          : [
              {
                pane_type: 'project',
                project_id: 'registered',
                pane_name: 'Custom project pane',
                sessions: [
                  { id: '123e4567-e89b-12d3-a456-426614174000', mode: 'claude', is_alive: true },
                  { id: '123e4567-e89b-12d3-a456-426614174098', mode: 'shell', is_alive: true },
                ],
              },
            ],
      ),
    ) as unknown as typeof fetch

    const result = await enrichATermSessions(live, projects, {
      port: 8765,
      timeoutMs: 2000,
      fetchFn,
    })
    expect(result.map(({ session, label, project }) => ({ session, label, project }))).toEqual([
      { session: live[0].session, label: 'Custom project pane', project: 'Agent Hub' },
      { session: live[1].session, label: 'Scratchpad', project: 'Ad-Hoc Shell' },
    ])
    expect(fetchFn).toHaveBeenCalledTimes(2)
    expect(fetchFn).toHaveBeenCalledWith(
      'http://127.0.0.1:8765/api/a-term/panes',
      expect.any(Object),
    )
    expect(fetchFn).toHaveBeenCalledWith(
      'http://127.0.0.1:8765/api/a-term/panes/detached',
      expect.any(Object),
    )
  })

  it('keeps tmux rows visible with generic labels when A-Term metadata is unavailable or stale', async () => {
    const fetchFn = vi.fn(async (url: string) => {
      if (url.endsWith('/detached')) throw new Error('unavailable')
      return response([
        {
          pane_type: 'project',
          project_id: 'registered',
          pane_name: 'Stale',
          sessions: [
            { id: '123e4567-e89b-12d3-a456-426614174000', mode: 'shell', is_alive: false },
          ],
        },
      ])
    }) as unknown as typeof fetch
    const result = await enrichATermSessions(live, projects, {
      port: 8002,
      timeoutMs: 2000,
      fetchFn,
    })
    expect(result.map(({ label, project }) => ({ label, project }))).toEqual([
      { label: 'A-Term 123e4567', project: 'Agent Hub' },
      { label: 'A-Term 123e4567', project: '/home/me' },
    ])
  })

  it('uses pane name for an unregistered project and keeps the successful endpoint when the other fails', async () => {
    const fetchFn = vi.fn(async (url: string) => {
      if (url.endsWith('/detached')) throw new Error('unavailable')
      return response([
        {
          pane_type: 'project',
          project_id: 'unknown',
          pane_name: 'Local Project',
          sessions: [{ id: '123e4567-e89b-12d3-a456-426614174000', mode: 'shell', is_alive: true }],
        },
      ])
    }) as unknown as typeof fetch
    const result = await enrichATermSessions(live, projects, {
      port: 8002,
      timeoutMs: 2000,
      fetchFn,
    })
    expect(result.map(({ label, project }) => ({ label, project }))).toEqual([
      { label: 'Local Project', project: 'Local Project' },
      { label: 'A-Term 123e4567', project: '/home/me' },
    ])
  })

  it('does not query A-Term without tmux-confirmed rows', async () => {
    const fetchFn = vi.fn() as unknown as typeof fetch
    expect(
      await enrichATermSessions([], projects, { port: 8002, timeoutMs: 2000, fetchFn }),
    ).toEqual([])
    expect(fetchFn).not.toHaveBeenCalled()
  })

  it('keeps tmux rows available when the configured A-Term port is invalid', async () => {
    const fetchFn = vi.fn() as unknown as typeof fetch
    const result = await enrichATermSessions(live, projects, {
      port: Number('invalid'),
      timeoutMs: 2000,
      fetchFn,
    })
    expect(result[0]).toMatchObject({ label: 'A-Term 123e4567', project: 'Agent Hub' })
    expect(fetchFn).not.toHaveBeenCalled()
  })

  it('uses the registered project name for unnamed Aico rows and preserves custom names', () => {
    expect(openableWidgetLabel({ name: null, projectId: 'registered', seq: 7 }, projects)).toBe(
      'Agent Hub',
    )
    expect(openableWidgetLabel({ name: 'Custom', projectId: 'registered', seq: 7 }, projects)).toBe(
      'Custom',
    )
    expect(openableWidgetLabel({ name: null, projectId: null, seq: 7 }, projects)).toBe('Session 7')
  })

  it('keeps a deliberate attached A-Term rename while updating default labels from pane metadata', () => {
    const session = { ...live[0], label: 'Renamed pane' }
    expect(attachedATermLabel(null, session)).toBe('Renamed pane')
    expect(attachedATermLabel('A-Term 123e4567', session)).toBe('Renamed pane')
    expect(attachedATermLabel('My Aico name', session)).toBe('My Aico name')
  })

  it('names unbound Aico project notes as ad hoc and uses A-Term pane mode when available', async () => {
    expect(openableWidgetProject({ projectId: null, tool: 'shell' }, projects)).toBe('Ad-Hoc Shell')
    expect(openableWidgetProject({ projectId: null, tool: 'codex' }, projects)).toBe('Ad-Hoc Codex')
    expect(openableWidgetProject({ projectId: 'registered', tool: 'shell' }, projects)).toBe(
      'Agent Hub',
    )
    const fetchFn = vi.fn(async () =>
      response([
        {
          pane_type: 'adhoc',
          project_id: null,
          pane_name: 'Ad-Hoc A-Term',
          sessions: [{ id: '123e4567-e89b-12d3-a456-426614174001', mode: 'codex', is_alive: true }],
        },
      ]),
    ) as unknown as typeof fetch
    const result = await enrichATermSessions(live, projects, {
      port: 8002,
      timeoutMs: 2000,
      fetchFn,
    })
    expect(result[1].project).toBe('Ad-Hoc Codex')
  })
})
