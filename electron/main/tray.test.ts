import { describe, expect, it, vi } from 'vitest'

const { menus } = vi.hoisted(() => ({ menus: [] as Record<string, unknown>[][] }))
vi.mock('electron', () => ({
  app: { quit: vi.fn() },
  Menu: { buildFromTemplate: (template: Record<string, unknown>[]) => template },
  nativeImage: { createFromPath: () => ({}) },
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

describe('tray tmux discovery', () => {
  it('refreshes a cached native menu and exposes an A-Term session created later', () => {
    menus.length = 0
    const onRefreshTmuxSessions = vi.fn(() => {
      refreshTray([], [], [{ id: 'default:a-term-new', label: 'A-Term new', source: 'A-Term' }])
    })
    const onAttachTmuxSession = vi.fn()
    createTray(
      {
        onSelect: vi.fn(),
        onDiscard: vi.fn(),
        onNewWidget: vi.fn(),
        onAttachTmuxSession,
        onRefreshTmuxSessions,
        onHubView: vi.fn(),
      },
      [],
      [],
      [],
    )
    const before = menus.at(-1) ?? []
    expect(item(before, 'Attach tmux session').submenu).toEqual([
      { label: 'No attachable sessions', enabled: false },
    ])

    ;(item(before, 'Refresh tmux sessions').click as () => void)()
    expect(onRefreshTmuxSessions).toHaveBeenCalledOnce()
    const after = menus.at(-1) ?? []
    const attach = (item(after, 'Attach tmux session').submenu as Record<string, unknown>[])[0]
    expect(attach.label).toBe('A-Term: A-Term new')
    ;(attach.click as () => void)()
    expect(onAttachTmuxSession).toHaveBeenCalledWith('default:a-term-new')
  })
})
