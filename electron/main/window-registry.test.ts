import type { BrowserWindow, WebContents } from 'electron'
import { describe, expect, it } from 'vitest'
import { WindowRegistry } from './window-registry'

function setup(ids: number[], focusedId?: number) {
  const wins = ids.map((id) => {
    let destroyed = false
    return {
      id,
      webContents: { id: id * 10 },
      isDestroyed: () => destroyed,
      destroy: () => {
        destroyed = true
      },
    }
  })
  const registry = new WindowRegistry({
    fromId: (id) => (wins.find((w) => w.id === id) ?? null) as unknown as BrowserWindow | null,
    fromWebContents: (wc) =>
      (wins.find((w) => w.webContents === (wc as unknown)) ??
        null) as unknown as BrowserWindow | null,
    getAllWindows: () => wins as unknown as BrowserWindow[],
    getFocusedWindow: () =>
      (wins.find((w) => w.id === focusedId) ?? null) as unknown as BrowserWindow | null,
  })
  const sender = (id: number) =>
    wins.find((w) => w.id === id)?.webContents as unknown as WebContents
  return { registry, wins, sender }
}

describe('WindowRegistry', () => {
  it('binds windows to sessions and finds them both ways', () => {
    const { registry, wins } = setup([1, 2])
    registry.bindSession(1, 'aaaaaaaa')
    expect(registry.sessionOf(1)).toBe('aaaaaaaa')
    expect(registry.hasSession(1)).toBe(true)
    expect(registry.hasSession(2)).toBe(false)
    expect(registry.forSession('aaaaaaaa')).toBe(wins[0])
    expect(registry.forSession('bbbbbbbb')).toBeUndefined()
  })

  it('lists only the windows bound to a session', () => {
    const { registry, wins } = setup([1, 2])
    registry.bindSession(1, 'aaaaaaaa')
    expect(registry.sessionWindows()).toEqual([wins[0]])
  })

  it('remembers a pending create until it is cleared', () => {
    const { registry } = setup([1])
    registry.setPending(1, { tool: 'shell', projectId: 'p' })
    expect(registry.pending(1)).toEqual({ tool: 'shell', projectId: 'p' })
    registry.clearPending(1)
    expect(registry.pending(1)).toBeUndefined()
  })

  it('skips destroyed windows and keeps binding order', () => {
    const { registry, wins } = setup([1, 2, 3])
    registry.bindSession(2, 'aaaaaaaa')
    registry.bindSession(1, 'aaaaaaaa')
    registry.bindSession(3, 'cccccccc')
    expect(registry.forSession('aaaaaaaa')).toBe(wins[1])
    wins[1]?.destroy()
    expect(registry.forSession('aaaaaaaa')).toBe(wins[0])
    wins[2]?.destroy()
    expect(registry.forSession('cccccccc')).toBeUndefined()
    expect(registry.sessionWindows()).toEqual([wins[0]])
  })

  it('maps an IPC sender to its window and session', () => {
    const { registry, wins, sender } = setup([1, 2])
    registry.bindSession(1, 'aaaaaaaa')
    expect(registry.senderWindow(sender(1))).toBe(wins[0])
    expect(registry.senderSession(sender(1))).toBe('aaaaaaaa')
    expect(registry.senderSession(sender(2))).toBeUndefined()
    const stranger = { id: 99 } as unknown as WebContents
    expect(registry.senderWindow(stranger)).toBeNull()
    expect(registry.senderSession(stranger)).toBeUndefined()
  })

  it('looks up any window, bound or not, by id, as a list and by focus', () => {
    const { registry, wins } = setup([1, 2], 2)
    registry.bindSession(1, 'aaaaaaaa')
    expect(registry.byId(2)).toBe(wins[1])
    expect(registry.byId(9)).toBeNull()
    expect(registry.all()).toEqual(wins)
    expect(registry.focused()).toBe(wins[1])
    expect(setup([1]).registry.focused()).toBeNull()
  })

  it('forgets every binding of a closed window', () => {
    const { registry } = setup([1, 2])
    registry.bindSession(1, 'aaaaaaaa')
    registry.setPending(1, { tool: 'shell', projectId: 'p' })
    registry.bindSession(2, 'bbbbbbbb')
    registry.forget(1)
    expect(registry.sessionOf(1)).toBeUndefined()
    expect(registry.pending(1)).toBeUndefined()
    expect(registry.sessionOf(2)).toBe('bbbbbbbb')
  })
})
