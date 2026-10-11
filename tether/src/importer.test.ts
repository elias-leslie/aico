import { createHash } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { applyImport, formatPlan, planImportForPath, summarize } from './importer'
import { bindCatalog, getWidget } from './lifecycle/catalog'
import { sessionGeneration } from './lifecycle/owner-retirement'
import { Store } from './store'

const SERVER = '06e633492f792ad10439f675491801ee'
const DEAD = '1'.repeat(32)
let dir: string
let source: string
let target: string

/** A minimal aico.db with Aico's exact table shapes. */
function seedAico(path: string): void {
  const db = new DatabaseSync(path)
  db.exec(`
    CREATE TABLE widgets (
      id TEXT PRIMARY KEY, seq INTEGER NOT NULL, x INTEGER, y INTEGER, width INTEGER,
      height INTEGER, display_id TEXT, open INTEGER NOT NULL DEFAULT 1, created_at INTEGER NOT NULL,
      tool TEXT NOT NULL DEFAULT 'shell', name TEXT, project_id TEXT, project_root TEXT,
      external_tmux_socket TEXT, external_tmux_session TEXT, tmux_server_id TEXT,
      tmux_allocation_state TEXT NOT NULL DEFAULT 'legacy-unclassified', tmux_session_id TEXT,
      pane_id TEXT, session_id TEXT, scope_unit TEXT, scope_invocation_id TEXT,
      pending_scope_unit TEXT, pending_scope_invocation_id TEXT,
      launch_state TEXT NOT NULL DEFAULT 'none', launch_nonce TEXT,
      lifecycle_version INTEGER NOT NULL DEFAULT 0);
    CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE tmux_servers (id TEXT PRIMARY KEY, kind TEXT NOT NULL, phase TEXT NOT NULL,
      socket_path TEXT NOT NULL UNIQUE, scope_unit TEXT NOT NULL, control_group TEXT,
      invocation_id TEXT, server_pid INTEGER, proc_starttime TEXT, created_at INTEGER NOT NULL,
      dead_at INTEGER);
    CREATE TABLE root_requests (request_id TEXT PRIMARY KEY, digest TEXT NOT NULL,
      widget_id TEXT NOT NULL UNIQUE, logical_session_id TEXT NOT NULL UNIQUE, role TEXT NOT NULL,
      lead_root_reference TEXT, facet_capsule_ref TEXT, created_at INTEGER NOT NULL);
    INSERT INTO settings VALUES ('defaultTool', 'claude-code');
    INSERT INTO tmux_servers VALUES ('${SERVER}', 'managed', 'active', '/home/u/.local/state/aico/tmux/${SERVER}/server.sock',
      'aico-tmux-server-${SERVER}.service', '/user.slice/x', '${'b'.repeat(32)}', 4242, '99', 10, NULL);
    INSERT INTO tmux_servers VALUES ('${DEAD}', 'managed', 'dead', '/home/u/.local/state/aico/tmux/${DEAD}/server.sock',
      'aico-tmux-server-${DEAD}.service', NULL, NULL, NULL, NULL, 5, 6);
    INSERT INTO widgets (id, seq, x, y, width, height, display_id, open, created_at, tool, name,
      project_id, project_root, tmux_server_id, tmux_allocation_state, tmux_session_id, pane_id,
      session_id, scope_unit, scope_invocation_id, launch_state, launch_nonce, lifecycle_version)
      VALUES ('05e96622', 3, 10, 20, 800, 600, '1', 1, 1000, 'claude-code', 'Main', 'aico',
      '/srv/workspaces/projects/aico', '${SERVER}', 'bound', '$3', '%7', 'aico-widget-05e96622',
      'tmux-spawn-00000000-0000-4000-8000-000000000000.scope', '${'c'.repeat(32)}', 'dispatched',
      '${'d'.repeat(32)}', 1);
    INSERT INTO widgets (id, seq, created_at, tool, external_tmux_socket, external_tmux_session,
      tmux_allocation_state) VALUES ('0e0e0e0e', 4, 1001, 'shell', '/tmp/tmux-1/default',
      'summitflow-x', 'external');
    INSERT INTO widgets (id, seq, created_at, tool, tmux_allocation_state, session_id)
      VALUES ('7a7a7a7a', 5, 1002, 'codex', 'unallocated', 'aico-widget-7a7a7a7a');
    INSERT INTO root_requests VALUES ('req-1', 'digest', '7a7a7a7a', 'aico-root-1', 'lead', NULL, NULL, 1002);
    INSERT INTO root_requests VALUES ('req-old', 'digest2', 'ffffffff', 'aico-root-0', 'lead', NULL, NULL, 900);
  `)
  db.close()
}

/** Aico's own generation (electron/main/owner-retirement.ts), computed on aico.db. */
function aicoGeneration(path: string, id: string): string {
  const db = new DatabaseSync(path, { readOnly: true })
  const row = db.prepare('SELECT * FROM widgets WHERE id = ?').get(id) as Record<string, unknown>
  db.close()
  return createHash('sha256')
    .update(
      JSON.stringify([
        row.id,
        row.session_id || `aico-widget-${row.id}`,
        row.external_tmux_socket ?? null,
        row.external_tmux_session ?? null,
        {
          scopeUnit: row.scope_unit ?? null,
          scopeInvocationId: row.scope_invocation_id ?? null,
          pendingScopeUnit: row.pending_scope_unit ?? null,
          pendingScopeInvocationId: row.pending_scope_invocation_id ?? null,
          lifecycleVersion: row.lifecycle_version ?? 0,
          tmuxSessionId: row.tmux_session_id ?? null,
          paneId: row.pane_id ?? null,
          tmuxServerId: row.tmux_server_id ?? null,
          tmuxAllocationState: row.tmux_allocation_state ?? 'legacy-unclassified',
          launchState: row.launch_state ?? 'none',
          launchNonce: row.launch_nonce ?? null,
        },
      ]),
    )
    .digest('hex')
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'tether-import-'))
  source = join(dir, 'aico.db')
  target = join(dir, 'tether', 'tether.db')
  seedAico(source)
})

afterEach(() => rmSync(dir, { recursive: true, force: true }))

describe('import-aico', () => {
  it('dry-run plans every server, root and internal widget without creating the target', () => {
    const plan = planImportForPath(source, target)
    expect(summarize(plan)).toEqual({
      tmux_servers: { insert: 2, same: 0, kept: 0, 'skip-external': 0 },
      sessions: { insert: 2, same: 0, kept: 0, 'skip-external': 1 },
      root_requests: { insert: 2, same: 0, kept: 0, 'skip-external': 0 },
    })
    expect(() => statSync(target)).toThrow()
    expect(formatPlan(plan, false).at(-1)).toContain('--apply')
  })

  it('applies once, never modifies aico.db, and is idempotent', () => {
    const before = readFileSync(source)
    const store = new Store(target)
    try {
      applyImport(source, store)
      bindCatalog(store.db)
      const imported = getWidget('05e96622')
      expect(imported).toMatchObject({
        tool: 'claude-code',
        name: 'Main',
        projectId: 'aico',
        tmuxServerId: SERVER,
        tmuxSessionId: '$3',
        paneId: '%7',
        launchState: 'dispatched',
        lifecycleVersion: 1,
        origin: 'aico',
      })
      expect(getWidget('7a7a7a7a')?.origin).toBe('root')
      expect(getWidget('0e0e0e0e')).toBeUndefined()
      // A generation read from Aico stays valid against the imported row.
      expect(sessionGeneration(imported as NonNullable<typeof imported>)).toBe(
        aicoGeneration(source, '05e96622'),
      )

      const again = applyImport(source, store)
      expect(summarize(again).sessions).toMatchObject({ insert: 0, same: 2 })
      expect(summarize(again).tmux_servers).toMatchObject({ insert: 0, same: 2 })
      expect(summarize(again).root_requests).toMatchObject({ insert: 0, same: 2 })

      // Tether is authoritative after import: a changed row is kept, not overwritten.
      store.db.prepare("UPDATE sessions SET name = 'Renamed' WHERE id = '05e96622'").run()
      const third = applyImport(source, store)
      expect(third.entries.find((entry) => entry.key === '05e96622')).toMatchObject({
        action: 'kept',
        differs: ['name'],
      })
      expect(getWidget('05e96622')?.name).toBe('Renamed')
    } finally {
      store.close()
    }
    expect(readFileSync(source).equals(before)).toBe(true)
  })

  it('rolls back everything when one row conflicts', () => {
    const store = new Store(target)
    try {
      // A second live managed service generation violates the one-live index.
      const other = '2'.repeat(32)
      store.db
        .prepare(
          `INSERT INTO tmux_servers (id, kind, phase, socket_path, scope_unit, control_group,
             invocation_id, server_pid, proc_starttime, created_at)
           VALUES (?, 'managed', 'active', '/x/s.sock', ?, '/cg', ?, 1, '1', 1)`,
        )
        .run(other, `tether-dev-tmux-server-${other}.service`, 'e'.repeat(32))
      expect(() => applyImport(source, store)).toThrow()
      const count = store.db.prepare('SELECT count(*) AS n FROM sessions').get() as { n: number }
      expect(count.n).toBe(0)
    } finally {
      store.close()
    }
  })
})
