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

/** An aico.db from before Tether, with its old tables still present. */
function legacyCatalog(path: string): void {
  const db = new DatabaseSync(path)
  db.exec(`
    CREATE TABLE widgets (id TEXT PRIMARY KEY, seq INTEGER NOT NULL, x INTEGER, y INTEGER,
      width INTEGER, height INTEGER, display_id TEXT, open INTEGER NOT NULL DEFAULT 1);
    CREATE TABLE tmux_servers (id TEXT PRIMARY KEY);
    CREATE TABLE root_requests (request_id TEXT PRIMARY KEY, widget_id TEXT NOT NULL);
    INSERT INTO widgets VALUES ('05e96622', 3, 10, 20, 900, 560, '1', 1);
    INSERT INTO tmux_servers VALUES ('srv');
    INSERT INTO root_requests VALUES ('root-1', '05e96622');
  `)
  db.close()
}

describe('view store setup', () => {
  it('leaves the pre-Tether tables untouched and never copies them into views', () => {
    const path = scratchDb()
    legacyCatalog(path)
    initViews(path)
    expect(listViews()).toEqual([])
    const check = new DatabaseSync(path)
    expect(check.prepare('SELECT id, x, open FROM widgets').all()).toEqual([
      { id: '05e96622', x: 10, open: 1 },
    ])
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

  it('starts empty on a new database', () => {
    initViews(scratchDb())
    expect(listViews()).toEqual([])
  })

  it('creates a missing state directory (fresh profile or AICO_STATE_DIR)', () => {
    const path = join(dirname(scratchDb()), 'state', 'aico', 'aico.db')
    initViews(path)
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
    removeView('0a1b2c3e')
    expect(getView('0a1b2c3e')).toBeUndefined()
    setSetting('arcade', 'off')
    expect(getSetting('arcade')).toBe('off')
  })
})
