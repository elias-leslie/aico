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
      refreshTray([{ id: '0a1b2c3d', label: 'A-Term session', open: false }], [], [])
    })
    createTray(
      {
        onSelect,
        onDiscard: vi.fn(),
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
    item(after, 'Idle')
    const open = item(after, '○ A-Term session')
    ;(open.click as () => void)()
    expect(onSelect).toHaveBeenCalledWith('0a1b2c3d')
  })

  it('names an unreachable Tether at the top of the menu', () => {
    menus.length = 0
    refreshTray([], [], [], 'Tether unavailable: sessions keep running')
    const menu = menus.at(-1) ?? []
    expect(menu[0]).toEqual({ label: 'Tether unavailable: sessions keep running', enabled: false })
  })
})

describe('tray attention groups', () => {
  it('lists groups most-urgent first with state and age', () => {
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
    expect(labels.slice(0, 6)).toEqual([
      'Needs you',
      '● aico — waiting 3m',
      'Finished',
      '○ tether — done 1m',
      'Working',
      '● neri — working 9m',
    ])
    expect(labels).not.toContain('Idle')
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
