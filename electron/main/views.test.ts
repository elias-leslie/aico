import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it } from 'vitest'
import {
  ensureView,
  getSetting,
  getView,
  initViews,
  listViews,
  removeView,
  saveBounds,
  setOpen,
  setSetting,
  VIEWS_MIGRATED_SETTING,
} from './views'

const dirs: string[] = []
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function scratchDb(): string {
  const dir = mkdtempSync(join(tmpdir(), 'aico-views-test-'))
  dirs.push(dir)
  return join(dir, 'aico.db')
}

/** The pre-Tether catalog shape (only the columns the migration reads). */
function legacyCatalog(path: string): DatabaseSync {
  const db = new DatabaseSync(path)
  db.exec(`
    CREATE TABLE widgets (
      id TEXT PRIMARY KEY, seq INTEGER NOT NULL, x INTEGER, y INTEGER, width INTEGER,
      height INTEGER, display_id TEXT, open INTEGER NOT NULL DEFAULT 1,
      created_at INTEGER NOT NULL, tool TEXT NOT NULL DEFAULT 'shell', name TEXT,
      external_tmux_socket TEXT, external_tmux_session TEXT,
      tmux_server_id TEXT, scope_unit TEXT
    );
    CREATE TABLE tmux_servers (id TEXT PRIMARY KEY);
    CREATE TABLE root_requests (request_id TEXT PRIMARY KEY, widget_id TEXT NOT NULL);
    CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    INSERT INTO widgets (id, seq, x, y, width, height, display_id, open, created_at, name, tmux_server_id, scope_unit)
      VALUES ('05e96622', 3, 10, 20, 900, 560, '1', 1, 1, 'Main', 'srv', 'tmux-spawn-a.scope'),
             ('0a1b2c3d', 1, NULL, NULL, NULL, NULL, NULL, 0, 2, NULL, 'srv', NULL);
    INSERT INTO widgets (id, seq, open, created_at, external_tmux_session)
      VALUES ('deadbeef', 2, 1, 3, 'summitflow-00000000-0000-4000-8000-000000000001');
    INSERT INTO tmux_servers VALUES ('srv');
    INSERT INTO root_requests VALUES ('root-1', '05e96622');
    INSERT INTO settings VALUES ('pins', '["new:codex","tmux:default:summitflow-x","session:aico:05e96622"]');
  `)
  return db
}

describe('view store migration', () => {
  it('copies internal widget views once and leaves the old tables untouched', () => {
    const path = scratchDb()
    const legacy = legacyCatalog(path)
    const before = legacy.prepare('SELECT * FROM widgets ORDER BY id').all()
    legacy.close()

    expect(initViews(path)).toEqual({ migrated: 2 })
    expect(listViews()).toEqual([
      {
        id: '0a1b2c3d',
        seq: 1,
        bounds: null,
        displayId: null,
        open: false,
        nameOverride: null,
        coordinator: false,
      },
      {
        id: '05e96622',
        seq: 3,
        bounds: { x: 10, y: 20, width: 900, height: 560 },
        displayId: '1',
        open: true,
        nameOverride: null,
        coordinator: false,
      },
    ])
    expect(getView('deadbeef')).toBeUndefined() // A-Term federation rows are not views
    expect(JSON.parse(getSetting('pins') ?? '[]')).toEqual(['new:codex', 'session:aico:05e96622'])
    expect(getSetting(VIEWS_MIGRATED_SETTING)).toBeDefined()

    // Idempotent: a restart never re-copies or resurrects a forgotten view.
    removeView('0a1b2c3d')
    expect(initViews(path)).toEqual({ migrated: 0 })
    expect(getView('0a1b2c3d')).toBeUndefined()

    const check = new DatabaseSync(path)
    expect(check.prepare('SELECT * FROM widgets ORDER BY id').all()).toEqual(before)
    expect(check.prepare('SELECT COUNT(*) AS n FROM tmux_servers').get()).toEqual({ n: 1 })
    expect(check.prepare('SELECT COUNT(*) AS n FROM root_requests').get()).toEqual({ n: 1 })
    check.close()
  })

  it('adds the coordinator column to an existing views table, keeping rows', () => {
    const path = scratchDb()
    const old = new DatabaseSync(path)
    old.exec(`
      CREATE TABLE views (widget_id TEXT PRIMARY KEY, seq INTEGER NOT NULL, x INTEGER,
        y INTEGER, width INTEGER, height INTEGER, display_id TEXT,
        open INTEGER NOT NULL DEFAULT 1, name_override TEXT);
      INSERT INTO views (widget_id, seq, open) VALUES ('0a1b2c3d', 1, 1);
    `)
    old.close()
    initViews(path)
    expect(getView('0a1b2c3d')).toMatchObject({ open: true, coordinator: false })
    initViews(path) // a second launch finds the column already there
    expect(listViews()).toHaveLength(1)
  })

  it('starts empty without a pre-Tether catalog', () => {
    expect(initViews(scratchDb())).toEqual({ migrated: 0 })
    expect(listViews()).toEqual([])
  })

  it('creates a missing state directory (fresh profile or AICO_STATE_DIR)', () => {
    const path = join(dirname(scratchDb()), 'state', 'aico', 'aico.db')
    expect(initViews(path)).toEqual({ migrated: 0 })
    expect(existsSync(path)).toBe(true)
  })
})

describe('views', () => {
  it('creates a view on first use and keeps geometry and open state', () => {
    initViews(scratchDb())
    expect(ensureView('0a1b2c3d', true)).toMatchObject({ id: '0a1b2c3d', seq: 1, open: true })
    saveBounds('0a1b2c3e', { x: 1, y: 2, width: 400, height: 300 }, '7')
    expect(getView('0a1b2c3e')).toMatchObject({
      seq: 2,
      open: false,
      bounds: { x: 1, y: 2, width: 400, height: 300 },
      displayId: '7',
    })
    setOpen('0a1b2c3d', false)
    expect(getView('0a1b2c3d')?.open).toBe(false)
    expect(ensureView('0a1b2c3d', true).open).toBe(false) // existing rows are not reset
    expect(() => ensureView('not-an-id')).toThrow()
    setSetting('arcade', 'off')
    expect(getSetting('arcade')).toBe('off')
  })
})
