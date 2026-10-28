import { describe, expect, it, vi } from 'vitest'

const { menus } = vi.hoisted(() => ({ menus: [] as Record<string, unknown>[][] }))
vi.mock('electron', () => ({
  app: { quit: vi.fn() },
  Menu: { buildFromTemplate: (template: Record<string, unknown>[]) => template },
  nativeImage: { createFromPath: () => ({ isEmpty: () => false }) },
  Tray: class {
    setToolTip() {}
    setImage() {}
    setContextMenu(menu: Record<string, unknown>[]) {
      menus.push(menu)
    }
  },
}))

import type { RunMember } from 'tether/client'
import { createTray, refreshTray } from './tray'

function item(menu: Record<string, unknown>[], label: string): Record<string, unknown> {
  const found = menu.find((entry) => entry.label === label)
  if (!found) throw new Error(`Missing tray item ${label}`)
  return found
}

describe('tray session catalog', () => {
  it('refreshes a cached native menu and exposes a session created elsewhere', () => {
    menus.length = 0
    const onSelect = vi.fn()
    const onRefreshSessions = vi.fn(() => {
      refreshTray([{ id: '0a1b2c3d', label: 'Web session', open: false }], [], [])
    })
    createTray(
      {
        onSelect,
        onDiscard: vi.fn(),
        onCancelCheckIn: vi.fn(),
        onNewWidget: vi.fn(),
        onRefreshSessions,
        onHubView: vi.fn(),
      },
      [],
      [],
    )
    const before = menus.at(-1) ?? []
    item(before, 'No sessions')

    ;(item(before, 'Refresh sessions').click as () => void)()
    expect(onRefreshSessions).toHaveBeenCalledOnce()
    const after = menus.at(-1) ?? []
    const open = item(after, '○ Web session')
    ;(open.click as () => void)()
    expect(onSelect).toHaveBeenCalledWith('0a1b2c3d')
  })

  it('shows the next check-in on the row and cancels one from Check-ins', () => {
    const onCancelCheckIn = vi.fn()
    createTray(
      {
        onSelect: vi.fn(),
        onDiscard: vi.fn(),
        onCancelCheckIn,
        onNewWidget: vi.fn(),
        onRefreshSessions: vi.fn(),
        onHubView: vi.fn(),
      },
      [],
      [],
    )
    menus.length = 0
    refreshTray(
      [
        {
          id: '0a1b2c3d',
          label: 'Docs · Codex',
          open: true,
          group: 'idle',
          detail: 'idle',
          checkIns: [
            { id: '5f1c0a9b2e7d', time: '5:30 PM' },
            { id: '5f1c0a9b2e7e', time: 'Tue 9:00 AM' },
          ],
        },
      ],
      [],
      [],
    )
    const menu = menus.at(-1) ?? []
    item(menu, '● Docs · Codex — idle · check-in 5:30 PM')
    const checkIns = item(menu, 'Check-ins').submenu as Record<string, unknown>[]
    expect(checkIns.map((entry) => entry.label)).toEqual([
      'Docs · Codex — 5:30 PM',
      'Docs · Codex — Tue 9:00 AM',
    ])
    const second = checkIns[1] as Record<string, unknown>
    const cancel = item(second.submenu as Record<string, unknown>[], 'Cancel check-in')
    ;(cancel.click as () => void)()
    expect(onCancelCheckIn).toHaveBeenCalledWith('5f1c0a9b2e7e')
  })

  it('names an unreachable Tether at the top of the menu', () => {
    menus.length = 0
    refreshTray([], [], [], 'Tether unavailable: sessions keep running')
    const menu = menus.at(-1) ?? []
    expect(menu[0]).toEqual({ label: 'Tether unavailable: sessions keep running', enabled: false })
  })

  it('keeps an open native menu when the catalog has not changed', () => {
    const rows = [
      { id: 'a', label: 'a', open: true, group: 'working' as const, detail: 'working 3m' },
    ]
    refreshTray(rows, [], [])
    menus.length = 0
    refreshTray(
      rows.map((row) => ({ ...row })),
      [],
      [],
    )
    expect(menus).toHaveLength(0)
    refreshTray([{ ...rows[0], detail: 'working 4m' }], [], [])
    expect(menus).toHaveLength(1)
  })
})

describe('tray attention groups', () => {
  it('heads the menu with Needs you and keeps the other sessions in order', () => {
    menus.length = 0
    refreshTray(
      [
        { id: 'a', label: 'aico', open: true, group: 'needs-you', detail: 'waiting 3m' },
        { id: 'b', label: 'tether', open: false, group: 'finished', detail: 'done 1m' },
        { id: 'c', label: 'neri', open: true, group: 'working', detail: 'working 9m' },
      ],
      [],
      [],
    )
    const labels = (menus.at(-1) ?? []).map((entry) => entry.label)
    expect(labels.slice(0, 5)).toEqual([
      'Needs you',
      '● aico — waiting 3m',
      'Other sessions',
      '○ tether — done 1m',
      '● neri — working 9m',
    ])
  })

  it('has no headings when nothing needs you', () => {
    menus.length = 0
    refreshTray(
      [
        { id: 'b', label: 'tether', open: false, group: 'idle', detail: 'idle 1m' },
        { id: 'c', label: 'neri', open: true, group: 'working', detail: 'working 9m' },
      ],
      [],
      [],
    )
    const labels = (menus.at(-1) ?? []).map((entry) => entry.label)
    expect(labels.slice(0, 2)).toEqual(['○ tether — idle 1m', '● neri — working 9m'])
    expect(labels).not.toContain('Other sessions')
  })
})

describe('tray coordinator teams', () => {
  it('folds lanes into one submenu per coordinator with its summary', () => {
    const onSelect = vi.fn()
    createTray(
      {
        onSelect,
        onDiscard: vi.fn(),
        onCancelCheckIn: vi.fn(),
        onNewWidget: vi.fn(),
        onRefreshSessions: vi.fn(),
        onHubView: vi.fn(),
      },
      [],
      [],
    )
    menus.length = 0
    const session = (id: string, title: string, extra: Record<string, unknown>) => ({
      id,
      label: `${title} · Codex`,
      title,
      tool: 'Codex',
      open: false,
      ...extra,
    })
    refreshTray(
      [
        session('lead', 'Neri — Daybreak lead', {
          coordinator: true,
          group: 'working',
          detail: 'working 2m',
          at: 1,
          checkIns: [{ id: 'w2', time: '6:00 PM', dueAt: 600 }],
        }),
        session('ask', 'Neri — Matomo pair lead', {
          coordinatorId: 'lead',
          group: 'needs-you',
          detail: 'waiting 1m',
          at: 2,
        }),
        session('busy', 'Neri — Scanner', {
          coordinatorId: 'lead',
          group: 'working',
          detail: 'working 5m',
          at: 3,
          checkIns: [{ id: 'w1', time: '5:30 PM', dueAt: 500 }],
        }),
        session('done', 'Aico — Tray', {
          coordinatorId: 'lead',
          group: 'finished',
          detail: 'done 1m',
          at: 4,
        }),
        session('left', 'Docs — Notes', {
          coordinatorId: 'ended',
          group: 'idle',
          detail: 'idle 1h',
          at: 5,
        }),
      ],
      [],
      [],
    )
    const menu = menus.at(-1) ?? []
    const labels = menu.map((entry) => entry.label)
    expect(labels.slice(0, 4)).toEqual([
      'Needs you',
      '○ Neri — Daybreak lead · Codex — working 2m · 1 working, 1 needs you, 1 idle · check-in 5:30 PM',
      'Other sessions',
      '○ Docs — Notes · Codex — idle 1h · coordinator ended',
    ])
    // Each session appears once in the session rows.
    expect(labels).not.toContain('Working')
    const team = menu[1].submenu as Record<string, unknown>[]
    expect(team.map((entry) => entry.label ?? entry.type)).toEqual([
      '○ Neri — Daybreak lead · Codex — working 2m · check-in 6:00 PM',
      'separator',
      '○ Matomo pair lead · Codex — waiting 1m',
      '○ Scanner · Codex — working 5m · check-in 5:30 PM',
      '○ Aico — Tray · Codex — done 1m',
    ])
    ;(team[0].click as () => void)()
    expect(onSelect).toHaveBeenCalledWith('lead')
  })
})

describe('tray icon', () => {
  it('shows needs-you over active over idle', async () => {
    const { setNeedsYou, setWidgetActivity, trayIcon } = await import('./tray')
    refreshTray([], [], [])
    expect(trayIcon()).toBe('idle')
    setWidgetActivity(1, true)
    expect(trayIcon()).toBe('active')
    setNeedsYou(true)
    expect(trayIcon()).toBe('needs-you')
    setNeedsYou(false)
    expect(trayIcon()).toBe('active')
    setWidgetActivity(1, false)
    expect(trayIcon()).toBe('idle')
    // Tether's working state counts as active too.
    refreshTray([{ id: 'a', label: 'a', open: true, group: 'working' }], [], [])
    expect(trayIcon()).toBe('active')
  })
})

describe('tray workflow runs', () => {
  function click(items: Record<string, unknown>[], label: string): void {
    const found = items.find((e) => e.label === label)
    if (!found) throw new Error(`Missing tray item ${label}`)
    ;(found.click as () => void)()
  }

  function open() {
    const onRun = vi.fn()
    createTray(
      {
        onSelect: vi.fn(),
        onDiscard: vi.fn(),
        onCancelCheckIn: vi.fn(),
        onNewWidget: vi.fn(),
        onRefreshSessions: vi.fn(),
        onHubView: vi.fn(),
        onRun,
      },
      [],
      [],
    )
    menus.length = 0
    return onRun
  }
  const run = (extra: Partial<RunMember>): RunMember => ({
    id: 'run:r1',
    kind: 'run',
    coordinator: false,
    coordinatorId: 'lead',
    runId: 'r1',
    stepKey: null,
    title: 'Ship it',
    group: 'working',
    at: null,
    word: 'running',
    status: 'running',
    url: 'http://hub.test/workflow-runs/r1',
    agent: null,
    requestedModel: null,
    servedModel: null,
    fallback: false,
    attempt: null,
    attemptLimit: null,
    reason: null,
    can: { decide: false, cancel: true, dismiss: false },
    cancelling: false,
    hint: 'Change the plan from the coordinator.',
    summary: '1 working',
    ...extra,
  })
  const widget = (m: RunMember) => ({
    id: m.id,
    label: m.title,
    open: false,
    group: m.group,
    detail: m.word,
    at: m.at,
    coordinator: false,
    coordinatorId: m.coordinatorId,
    kind: m.kind,
    summary: m.summary,
    run: m,
  })

  it('folds a run and its steps under the session that launched it, with controls', () => {
    const onRun = open()
    const waiting = run({
      id: 'step:r1:build',
      kind: 'step',
      coordinatorId: 'run:r1',
      stepKey: 'build',
      title: 'build',
      group: 'needs-you',
      word: 'waiting for you',
      hint: null,
      summary: null,
      can: { decide: true, cancel: true, dismiss: false },
    })
    refreshTray(
      [
        { id: 'lead', label: 'Lead · Codex', open: true, coordinator: true, group: 'idle' },
        widget(run({ group: 'needs-you', word: 'waiting for you' })),
        widget(waiting),
      ],
      [],
      [],
    )
    const menu = menus.at(-1) ?? []
    // The run needs the owner, so it shows under Needs you, inside its coordinator's team.
    const team = menu.find((entry) => String(entry.label).includes('Lead')) as Record<
      string,
      unknown
    >
    const runRow = (team.submenu as Record<string, unknown>[]).find((entry) =>
      String(entry.label).startsWith('◇ Ship it'),
    ) as Record<string, unknown>
    expect(runRow.label).toContain('waiting for you')
    const inner = runRow.submenu as Record<string, unknown>[]
    const stepRow = inner.find((entry) => String(entry.label).startsWith('· build')) as Record<
      string,
      unknown
    >
    const stepLabels = (stepRow.submenu as Record<string, unknown>[]).map((e) => e.label)
    expect(stepLabels).toEqual(
      expect.arrayContaining(['Open in Agent Hub', 'Retry step', 'Skip step', 'Fail step']),
    )
    expect(stepLabels).toContain('Cancel step')
    click(stepRow.submenu as Record<string, unknown>[], 'Retry step')
    expect(onRun).toHaveBeenCalledWith({
      type: 'resume',
      runId: 'r1',
      stepKey: 'build',
      action: 'retry',
    })
    // The run's own controls and the plan-change hint, which is not clickable.
    expect(inner.map((e) => e.label)).toEqual(
      expect.arrayContaining([
        'Open in Agent Hub',
        'Cancel run',
        'Change the plan from the coordinator.',
      ]),
    )
    expect(inner.find((e) => e.label === 'Change the plan from the coordinator.')?.enabled).toBe(
      false,
    )
  })

  it('offers Dismiss run on an ended run and opens its page', () => {
    const onRun = open()
    const ended = run({
      group: 'finished',
      word: 'completed',
      status: 'completed',
      hint: null,
      can: { decide: false, cancel: false, dismiss: true },
    })
    refreshTray([widget(ended)], [], [])
    const row = (menus.at(-1) ?? []).find((e) => String(e.label).startsWith('◇ Ship it')) as Record<
      string,
      unknown
    >
    const items = row.submenu as Record<string, unknown>[]
    click(items, 'Dismiss run')
    expect(onRun).toHaveBeenCalledWith({ type: 'dismiss', runId: 'r1' })
    click(items, 'Open in Agent Hub')
    expect(onRun).toHaveBeenCalledWith({ type: 'open', url: 'http://hub.test/workflow-runs/r1' })
  })

  it('keeps runs out of End session and Check-ins, and shows the runs notice', () => {
    open()
    refreshTray(
      [
        { id: 'lead', label: 'Lead · Codex', open: true, coordinator: true, group: 'idle' },
        widget(run({})),
      ],
      [],
      [],
      null,
      'Workflow runs may be out of date: Agent Hub is not reachable',
    )
    const menu = menus.at(-1) ?? []
    expect(menu[0]?.label).toBe('Workflow runs may be out of date: Agent Hub is not reachable')
    const end = menu.find((e) => e.label === 'End session') as Record<string, unknown>
    expect((end.submenu as Record<string, unknown>[]).map((e) => e.label)).toEqual(['Lead · Codex'])
  })
})
