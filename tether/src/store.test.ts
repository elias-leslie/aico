import { mkdtempSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { SCHEMA_VERSION } from './schema'
import { Store } from './store'
import { ToolValidationError } from './tools'

const stores: Store[] = []
function open(path = ':memory:'): Store {
  const store = new Store(path, () => 1_000)
  stores.push(store)
  return store
}
afterEach(() => {
  for (const store of stores.splice(0)) {
    try {
      store.close()
    } catch {
      // already closed
    }
  }
})

const seedTool = {
  slug: 'aider',
  name: 'Aider',
  argv: ['aider'],
  processName: 'aider',
  description: null,
  color: null,
  displayOrder: 5,
  isDefault: false,
  enabled: true,
  aliases: [],
  contextHook: null,
}

describe('Store schema', () => {
  it('shared mode keeps the state dir 0750 and the database 0640 (an owner ACL needs a mask that reads)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'tether-store-'))
    const path = join(dir, 'state', 'tether.db')
    new Store(path, Date.now, true).close()
    expect(statSync(path).mode & 0o777).toBe(0o640)
    expect(statSync(join(dir, 'state')).mode & 0o777).toBe(0o750)
    new Store(path).close() // an unshared start tightens them again
    expect(statSync(path).mode & 0o777).toBe(0o600)
  })

  it('creates schema v1 with WAL and its tables', () => {
    const dir = mkdtempSync(join(tmpdir(), 'tether-store-'))
    const store = open(join(dir, 'state', 'tether.db'))
    expect(store.schemaVersion()).toBe(SCHEMA_VERSION)
    expect(statSync(join(dir, 'state', 'tether.db')).mode & 0o777).toBe(0o600)
    expect(statSync(join(dir, 'state')).mode & 0o777).toBe(0o700)
    const mode = store.db.prepare('PRAGMA journal_mode').get() as { journal_mode: string }
    expect(mode.journal_mode).toBe('wal')
    const tables = (
      store.db
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
        .all() as {
        name: string
      }[]
    ).map((row) => row.name)
    expect(tables).toEqual([
      'agent_tools',
      'retired_session_ids',
      'root_requests',
      'schema_version',
      'sessions',
      'settings',
      'tmux_servers',
    ])
  })

  it('reopens without reseeding and refuses a newer schema', () => {
    const dir = mkdtempSync(join(tmpdir(), 'tether-store-'))
    const path = join(dir, 'tether.db')
    const first = open(path)
    first.deleteTool('agy')
    first.close()
    const second = open(path)
    expect(second.getTool('agy')).toBeUndefined()
    second.db.prepare('INSERT INTO schema_version (version, applied_at) VALUES (99, 0)').run()
    second.close()
    expect(() => open(path)).toThrow(/newer than this Tether build/)
  })

  it("keeps Aico's tmux_servers and root_requests columns for a byte-for-byte import", () => {
    const store = open()
    const columns = (table: string) =>
      (store.db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map(
        (c) => c.name,
      )
    expect(columns('tmux_servers')).toEqual([
      'id',
      'kind',
      'phase',
      'socket_path',
      'scope_unit',
      'control_group',
      'invocation_id',
      'server_pid',
      'proc_starttime',
      'created_at',
      'dead_at',
    ])
    expect(columns('root_requests')).toEqual([
      'request_id',
      'digest',
      'widget_id',
      'logical_session_id',
      'role',
      'lead_root_reference',
      'facet_capsule_ref',
      'created_at',
      // Tether v3: appended after Aico's columns, so the import stays positional.
      'origin',
    ])
    expect(columns('sessions').slice(0, 19)).toEqual([
      'id',
      'seq',
      'created_at',
      'tool',
      'name',
      'project_id',
      'project_root',
      'tmux_server_id',
      'tmux_allocation_state',
      'tmux_session_id',
      'pane_id',
      'session_id',
      'scope_unit',
      'scope_invocation_id',
      'pending_scope_unit',
      'pending_scope_invocation_id',
      'launch_state',
      'launch_nonce',
      'lifecycle_version',
    ])
  })

  it('accepts Aico and instance unit names and rejects foreign ones', () => {
    const store = open()
    const insert = store.db.prepare(
      `INSERT INTO tmux_servers (id, kind, phase, socket_path, scope_unit, created_at, dead_at)
       VALUES (?, 'managed', 'dead', ?, ?, 1, 2)`,
    )
    const id = (n: number) => `${n}`.padStart(32, 'a')
    insert.run(id(1), '/s/1', `aico-tmux-server-${id(1)}.scope`)
    insert.run(id(2), '/s/2', `aico-tmux-server-${id(2)}.service`)
    insert.run(id(3), '/s/3', `tether-dev-tmux-server-${id(3)}.service`)
    expect(() => insert.run(id(4), '/s/4', `tether-dev-tmux-server-${id(5)}.service`)).toThrow()
    expect(() => insert.run(id(6), '/s/6', `other-tmux-server-${id(6)}.service`)).toThrow()
    expect(() => insert.run(id(7), '/s/7', `tether-dev-tmux-server-${id(7)}.scope`)).toThrow()
  })
})

describe('agent tools', () => {
  it('seeds the merged registry with codex as default', () => {
    const store = open()
    const tools = store.listTools()
    expect(tools.map((tool) => tool.slug)).toEqual(['claude-code', 'codex', 'agy', 'pi', 'shell'])
    expect(store.defaultTool()?.slug).toBe('codex')
    expect(store.getTool('codex')?.command).toBe('codex --yolo')
    expect(store.getTool('shell')?.argv).toEqual([])
  })

  it("resolves A-Term's claude slug as an alias", () => {
    expect(open().resolveTool('claude')?.slug).toBe('claude-code')
  })

  it('moves the default atomically and keeps slug/alias names unique', () => {
    const store = open()
    store.updateTool('pi', { isDefault: true })
    expect(
      store
        .listTools()
        .filter((tool) => tool.isDefault)
        .map((tool) => tool.slug),
    ).toEqual(['pi'])
    expect(() => store.createTool({ ...seedTool, slug: 'claude' })).toThrow(ToolValidationError)
    expect(() => store.createTool({ ...seedTool, aliases: ['codex'] })).toThrow(ToolValidationError)
    const created = store.createTool({ ...seedTool, isDefault: true })
    expect(store.defaultTool()?.id).toBe(created.id)
  })

  it('validates fields', () => {
    const store = open()
    expect(() => store.createTool({ ...seedTool, slug: 'Bad Slug' })).toThrow(ToolValidationError)
    expect(() => store.updateTool('codex', { argv: ['a\nb'] })).toThrow(ToolValidationError)
    expect(() => store.updateTool('codex', { name: ' ' })).toThrow(ToolValidationError)
  })

  it('refuses to delete the default tool or one a session runs', () => {
    const store = open()
    expect(store.deleteTool('codex')).toBe('default_tool')
    store.db
      .prepare(
        "INSERT INTO sessions (id, seq, created_at, tool, session_id) VALUES ('0a1b2c3d', 1, 1, 'claude', 'aico-widget-0a1b2c3d')",
      )
      .run()
    expect(store.deleteTool('claude-code')).toBe('tool_in_use')
    expect(store.deleteTool('agy')).toBe('deleted')
    expect(store.deleteTool('agy')).toBe('absent')
    expect(store.listSessions()[0]?.ownershipId).toBe('aico-widget-0a1b2c3d')
  })
})

describe('settings', () => {
  it('stores one JSON value per key and replaces it', () => {
    const store = open(':memory:')
    expect(store.getSetting('memory_policy')).toBeNull()
    store.putSetting('memory_policy', '{"killMinGib":2}', 1)
    store.putSetting('memory_policy', '{"killMinGib":3}', 2)
    expect(store.getSetting('memory_policy')).toBe('{"killMinGib":3}')
    expect(() => store.putSetting('bad', 'not json', 3)).toThrow()
    store.close()
  })
})
