import { describe, expect, it, vi } from 'vitest'

const { menus } = vi.hoisted(() => ({ menus: [] as Record<string, unknown>[][] }))
vi.mock('electron', () => ({
  app: { quit: vi.fn() },
  Menu: { buildFromTemplate: (template: Record<string, unknown>[]) => template },
  nativeImage: { createFromPath: () => ({ isEmpty: () => false }) },
  Tray: class {
    setToolTip() {}
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
    expect(item(before, 'Open session').submenu).toEqual([
      { label: 'No sessions to open', enabled: false },
    ])

    ;(item(before, 'Refresh sessions').click as () => void)()
    expect(onRefreshSessions).toHaveBeenCalledOnce()
    const after = menus.at(-1) ?? []
    const open = (item(after, 'Open session').submenu as Record<string, unknown>[])[0]
    expect(open.label).toBe('A-Term session')
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
