import { createHash } from 'node:crypto'
import { mkdtempSync, readFileSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { describe, expect, it } from 'vitest'
import { WebStore } from './db'

/** The Python backend's a-term.db, as its schema stands. */
function oldDatabase(dir: string): string {
  const path = join(dir, 'a-term.db')
  const db = new DatabaseSync(path)
  db.exec(`
    CREATE TABLE project_settings (project_id TEXT PRIMARY KEY, enabled INTEGER NOT NULL DEFAULT 0,
      display_order INTEGER NOT NULL DEFAULT 0, active_mode TEXT NOT NULL DEFAULT 'shell',
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
    CREATE TABLE panes (id TEXT PRIMARY KEY, pane_type TEXT NOT NULL, project_id TEXT,
      pane_order INTEGER NOT NULL DEFAULT 0, pane_name TEXT NOT NULL, active_mode TEXT NOT NULL DEFAULT 'shell',
      width_percent REAL NOT NULL DEFAULT 100.0, height_percent REAL NOT NULL DEFAULT 100.0,
      grid_row INTEGER NOT NULL DEFAULT 0, grid_col INTEGER NOT NULL DEFAULT 0,
      is_detached INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL);
    CREATE TABLE pane_sessions (session_id TEXT PRIMARY KEY, pane_id TEXT NOT NULL REFERENCES panes(id),
      mode TEXT NOT NULL, kind TEXT NOT NULL DEFAULT 'tether', display_order INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL, last_accessed_at TEXT);
    INSERT INTO project_settings VALUES ('aico', 1, 2, 'codex', '2026-01-01', '2026-01-02');
    INSERT INTO project_settings VALUES ('other', 0, 0, 'shell', '2026-01-01', '2026-01-01');
    INSERT INTO panes VALUES ('p-live', 'project', 'aico', 0, 'Aico', 'codex', 100, 100, 0, 0, 0, '2026-01-01');
    INSERT INTO panes VALUES ('p-empty', 'adhoc', NULL, 1, 'Shell', 'shell', 100, 100, 0, 0, 0, '2026-01-01');
    INSERT INTO panes VALUES ('p-legacy', 'adhoc', NULL, 2, 'Old', 'shell', 100, 100, 0, 0, 0, '2026-01-01');
    INSERT INTO pane_sessions VALUES ('aaaa1111', 'p-live', 'shell', 'tether', 0, '2026-01-01', NULL);
    INSERT INTO pane_sessions VALUES ('bbbb2222', 'p-live', 'codex', 'tether', 1, '2026-01-01', '2026-01-03');
    INSERT INTO pane_sessions VALUES ('legacy-1', 'p-legacy', 'shell', 'legacy', 0, '2026-01-01', NULL);
  `)
  db.close()
  return path
}

const hash = (path: string) => createHash('sha256').update(readFileSync(path)).digest('hex')

describe('WebStore', () => {
  it('imports settings and the tabs that still show a Tether session, once, never writing the old file', () => {
    const dir = mkdtempSync(join(tmpdir(), 'aico-web-db-'))
    const old = oldDatabase(dir)
    const before = hash(old)
    const path = join(dir, 'state', 'web.db')
    const store = new WebStore(path)
    expect(store.importOnce(old)).toEqual({ source: old, projects: 2, panes: 1, links: 2 })
    expect(hash(old)).toBe(before)
    expect(statSync(path).mode & 0o777).toBe(0o600)
    expect(statSync(join(dir, 'state')).mode & 0o777).toBe(0o700)

    expect(store.listPanes().map((pane) => pane.id)).toEqual(['p-live'])
    expect(store.linksForPane('p-live').map((link) => [link.session_id, link.mode])).toEqual([
      ['bbbb2222', 'codex'],
      ['aaaa1111', 'shell'],
    ])
    const settings = store.allProjectSettings()
    expect(settings.get('aico')).toEqual({
      project_id: 'aico',
      enabled: true,
      display_order: 2,
      active_mode: 'codex',
    })
    expect(settings.get('other')?.enabled).toBe(false)

    // Once: a second open imports nothing, even if the old file changed.
    store.close()
    const again = new WebStore(path)
    expect(again.importOnce(old)).toBeNull()
    expect(again.meta('imported_from')).toBe(old)
    again.close()
  })

  it('counts a missing old database as imported', () => {
    const store = new WebStore(':memory:')
    expect(store.importOnce('/nonexistent/a-term.db')).toEqual({
      source: '/nonexistent/a-term.db',
      projects: 0,
      panes: 0,
      links: 0,
    })
    expect(store.importOnce('/nonexistent/a-term.db')).toBeNull()
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
})
