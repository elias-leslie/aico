import { mkdtempSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { WebStore } from './db'

describe('WebStore', () => {
  it('keeps the file owner-only', () => {
    const dir = mkdtempSync(join(tmpdir(), 'aico-web-db-'))
    const path = join(dir, 'state', 'web.db')
    new WebStore(path).close()
    expect(statSync(path).mode & 0o777).toBe(0o600)
    expect(statSync(join(dir, 'state')).mode & 0o777).toBe(0o700)
  })

  it('keeps tabs, links and settings', () => {
    const store = new WebStore(':memory:')
    const pane = store.createPane({ projectId: 'aico', name: 'Aico', activeMode: 'claude' })
    store.link('s1', pane.id, 'shell')
    store.link('s2', pane.id, 'claude')
    store.updateLink('s2', { displayOrder: 3 })
    expect(store.getLink('s2')?.display_order).toBe(3)
    store.updatePane(pane.id, { activeMode: 'shell', name: 'Renamed' })
    expect(store.getPane(pane.id)).toMatchObject({ name: 'Renamed', active_mode: 'shell' })
    expect(store.unlink('s1')).toBe(true)
    expect(store.deletePane(pane.id)).toBe(true)
    expect(store.getLink('s2')).toBeNull()

    expect(store.upsertProjectSettings('aico', { activeMode: 'codex' })).toMatchObject({
      enabled: false,
      active_mode: 'codex',
    })
    expect(store.upsertProjectSettings('aico', { enabled: true })).toMatchObject({
      enabled: true,
      active_mode: 'codex',
    })
  })
  it('keeps the latest seen time per session, and only the newest few', () => {
    const store = new WebStore(':memory:')
    store.markSeen(['aaaa0001', 'aaaa0002'], 100)
    store.markSeen(['aaaa0001'], 50)
    expect(store.seenAt()).toEqual(
      new Map([
        ['aaaa0001', 100],
        ['aaaa0002', 100],
      ]),
    )
    store.markSeen(['aaaa0003'], 200, 2)
    expect([...store.seenAt().keys()].sort()).toHaveLength(2)
    expect(store.seenAt().get('aaaa0003')).toBe(200)
  })
})
