import { mkdtempSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { describe, expect, it } from 'vitest'
import { SCHEMA_VERSION, WebStore } from './db'
import { changesSince } from './sync/engine'

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

  it('hides deleted tabs, links and settings, and brings them back when made again', () => {
    const store = new WebStore(':memory:')
    const pane = store.createPane({ projectId: 'aico', name: 'Aico', activeMode: 'shell' })
    store.link('s1', pane.id, 'shell')
    store.upsertProjectSettings('aico', { enabled: true, displayOrder: 4 })
    expect(store.deletePane(pane.id)).toBe(true)
    expect(store.deletePane(pane.id)).toBe(false)
    expect(store.getPane(pane.id)).toBeNull()
    expect(store.listPanes()).toEqual([])
    expect(store.getLink('s1')).toBeNull()
    expect(store.linksForPane(pane.id)).toEqual([])
    expect(store.updatePane(pane.id, { name: 'x' })).toBeNull()
    expect(store.pruneProjectSettings(new Set(['other']))).toBe(1)
    expect(store.allProjectSettings().size).toBe(0)
    // Rows are tombstones, not gone: a peer can still hear of the delete.
    const rows = changesSince(store.syncHandle(), 0, 100).rows
    expect(
      rows
        .filter((r) => r.row.deleted === 1)
        .map((r) => r.table)
        .sort(),
    ).toEqual(['panes', 'project_settings', 'session_links'])
    // Linking the session again starts a clean link; settings start from defaults.
    const other = store.createPane({ projectId: null, name: 'Shell', activeMode: 'shell' })
    expect(store.link('s1', other.id, 'claude')).toMatchObject({
      pane_id: other.id,
      mode: 'claude',
      display_order: 0,
    })
    expect(store.upsertProjectSettings('aico', { activeMode: 'codex' })).toMatchObject({
      enabled: false,
      display_order: 0,
      active_mode: 'codex',
    })
    expect(store.unlink('s1')).toBe(true)
    expect(store.unlink('s1')).toBe(false)
  })

  it('tombstones empty tabs past the cutoff only', () => {
    const store = new WebStore(':memory:')
    const empty = store.createPane({ projectId: null, name: 'Empty', activeMode: 'shell' })
    const used = store.createPane({ projectId: null, name: 'Used', activeMode: 'shell' })
    store.link('s1', used.id, 'shell')
    expect(store.deleteEmptyPanes(new Date(Date.now() - 86_400_000))).toBe(0)
    expect(store.deleteEmptyPanes(new Date(Date.now() + 1000))).toBe(1)
    expect(store.getPane(empty.id)).toBeNull()
    expect(store.getPane(used.id)).not.toBeNull()
  })

  it('does not stamp a change that changes nothing, nor opening a session', () => {
    const store = new WebStore(':memory:')
    const pane = store.createPane({ projectId: null, name: 'Same', activeMode: 'shell' })
    store.link('s1', pane.id, 'shell')
    const seq = store.meta('seq')
    store.updatePane(pane.id, { name: 'Same' })
    store.link('s1', pane.id, 'shell')
    store.touchLink('s1')
    store.markSeen(['s1'], 5)
    const afterSeen = store.meta('seq')
    store.markSeen(['s1'], 4)
    expect(afterSeen).toBe(String(Number(seq) + 1))
    expect(store.meta('seq')).toBe(afterSeen)
  })

  describe('from a schema 1 file', () => {
    const V1 = `
      CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE panes (id TEXT PRIMARY KEY, project_id TEXT, name TEXT NOT NULL,
        active_mode TEXT NOT NULL DEFAULT 'shell', created_at TEXT NOT NULL);
      CREATE TABLE session_links (session_id TEXT PRIMARY KEY,
        pane_id TEXT NOT NULL REFERENCES panes(id) ON DELETE CASCADE, mode TEXT NOT NULL,
        display_order INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL, last_accessed_at TEXT);
      CREATE TABLE session_seen (session_id TEXT PRIMARY KEY, seen_at INTEGER NOT NULL);
      CREATE TABLE project_settings (project_id TEXT PRIMARY KEY,
        enabled INTEGER NOT NULL DEFAULT 0 CHECK (enabled IN (0, 1)),
        display_order INTEGER NOT NULL DEFAULT 0, active_mode TEXT NOT NULL DEFAULT 'shell',
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
      INSERT INTO meta VALUES ('schema_version', '1');
      INSERT INTO panes VALUES ('p1', 'aico', 'Aico', 'claude', '2026-10-01T10:00:00.000Z');
      INSERT INTO panes VALUES ('p2', NULL, 'Shell', 'shell', '2026-10-02T10:00:00.000Z');
      INSERT INTO session_links VALUES ('s1', 'p1', 'shell', 1, '2026-10-01T10:00:01.000Z', '2026-10-03T00:00:00.000Z');
      INSERT INTO session_links VALUES ('s2', 'p1', 'claude', 2, '2026-10-01T10:00:02.000Z', NULL);
      INSERT INTO session_seen VALUES ('s1', 1700000000000);
      INSERT INTO project_settings VALUES ('aico', 1, 3, 'claude', '2026-09-01T00:00:00.000Z', '2026-10-04T00:00:00.000Z');`

    it('keeps every tab, link, setting and seen time, and makes them syncable', () => {
      const dir = mkdtempSync(join(tmpdir(), 'aico-web-v1-'))
      const path = join(dir, 'web.db')
      const legacy = new DatabaseSync(path)
      legacy.exec(V1)
      legacy.close()

      const store = new WebStore(path, { hostName: 'workstation' })
      expect(store.meta('schema_version')).toBe(String(SCHEMA_VERSION))
      expect(store.meta('db_id')).toMatch(/^[0-9a-f-]{36}$/)
      expect(store.listPanes()).toEqual([
        {
          id: 'p1',
          project_id: 'aico',
          name: 'Aico',
          active_mode: 'claude',
          created_at: '2026-10-01T10:00:00.000Z',
        },
        {
          id: 'p2',
          project_id: null,
          name: 'Shell',
          active_mode: 'shell',
          created_at: '2026-10-02T10:00:00.000Z',
        },
      ])
      expect(
        store.listLinks().map((l) => [l.session_id, l.mode, l.display_order, l.last_accessed_at]),
      ).toEqual([
        ['s2', 'claude', 2, null],
        ['s1', 'shell', 1, '2026-10-03T00:00:00.000Z'],
      ])
      expect(store.allProjectSettings().get('aico')).toEqual({
        project_id: 'aico',
        enabled: true,
        display_order: 3,
        active_mode: 'claude',
      })
      expect(store.seenAt().get('s1')).toBe(1_700_000_000_000)

      // Old rows got stamps (their own dates) and distinct change numbers.
      const rows = changesSince(store.syncHandle(), 0, 100).rows
      expect(rows).toHaveLength(6)
      expect(rows.map((r) => r.table).sort()).toEqual([
        'panes',
        'panes',
        'project_settings',
        'session_links',
        'session_links',
        'session_seen',
      ])
      expect(new Set(rows.map((r) => `${r.table}`)).size).toBe(4)
      const pane = rows.find((r) => r.row.id === 'p1')?.row
      expect(pane).toMatchObject({
        sync_at: Date.parse('2026-10-01T10:00:00.000Z'),
        origin: 'workstation',
        deleted: 0,
      })
      store.close()

      // A second open changes nothing, and the file still opens as one new tab can be added.
      const again = new WebStore(path, { hostName: 'workstation' })
      expect(again.meta('seq')).toBe('6')
      expect(again.createPane({ projectId: null, name: 'New', activeMode: 'shell' }).name).toBe(
        'New',
      )
      expect(again.meta('seq')).toBe('7')
      again.close()
      rmSync(dir, { recursive: true, force: true })
    })

    it('migrates a schema 2 file by adding prev_origin, keeping every row', () => {
      const dir = mkdtempSync(join(tmpdir(), 'aico-web-v2-'))
      const path = join(dir, 'web.db')
      const first = new WebStore(path, { hostName: 'workstation' })
      const pane = first.createPane({ projectId: 'aico', name: 'Aico', activeMode: 'claude' })
      first.link('s1', pane.id, 'shell')
      first.upsertProjectSettings('aico', { enabled: true })
      first.close()
      const raw = new DatabaseSync(path)
      raw.exec(
        `ALTER TABLE panes DROP COLUMN prev_origin; ALTER TABLE session_links DROP COLUMN prev_origin;
         ALTER TABLE project_settings DROP COLUMN prev_origin;
         UPDATE meta SET value = '2' WHERE key = 'schema_version'`,
      )
      raw.close()
      const store = new WebStore(path, { hostName: 'workstation' })
      expect(store.meta('schema_version')).toBe(String(SCHEMA_VERSION))
      expect(store.getPane(pane.id)?.name).toBe('Aico')
      expect(store.getLink('s1')?.pane_id).toBe(pane.id)
      expect(store.allProjectSettings().get('aico')?.enabled).toBe(true)
      store.close()
      rmSync(dir, { recursive: true, force: true })
    })

    it('refuses a file from a newer Aico', () => {
      const dir = mkdtempSync(join(tmpdir(), 'aico-web-v9-'))
      const path = join(dir, 'web.db')
      const legacy = new DatabaseSync(path)
      legacy.exec(V1.replace("'schema_version', '1'", "'schema_version', '99'"))
      legacy.close()
      expect(() => new WebStore(path)).toThrow(/newer than this Aico/)
      rmSync(dir, { recursive: true, force: true })
    })
  })
})
