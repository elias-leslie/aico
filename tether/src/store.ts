import { randomUUID } from 'node:crypto'
import { chmodSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import {
  AGENT_TOOLS_TABLE_SQL,
  INDEXES_SQL,
  ROOT_REQUESTS_TABLE_SQL,
  SCHEMA_VERSION,
  SESSIONS_TABLE_SQL,
  TMUX_SERVERS_TABLE_SQL,
} from './schema'
import {
  type AgentTool,
  DEFAULT_TOOLS,
  formatCommand,
  isContextHook,
  SLUG_RE,
  type ToolSeed,
  ToolValidationError,
  validateArgv,
} from './tools'

interface RawTool {
  id: string
  slug: string
  name: string
  argv: string
  process_name: string
  description: string | null
  color: string | null
  display_order: number
  is_default: number
  enabled: number
  aliases: string
  context_hook: string | null
  created_at: number
  updated_at: number
}

function toTool(raw: RawTool): AgentTool {
  const argv = JSON.parse(raw.argv) as string[]
  return {
    id: raw.id,
    slug: raw.slug,
    name: raw.name,
    argv,
    command: formatCommand(argv),
    processName: raw.process_name,
    description: raw.description,
    color: raw.color,
    displayOrder: raw.display_order,
    isDefault: raw.is_default === 1,
    enabled: raw.enabled === 1,
    aliases: JSON.parse(raw.aliases) as string[],
    contextHook: isContextHook(raw.context_hook) ? raw.context_hook : null,
    createdAt: raw.created_at,
    updatedAt: raw.updated_at,
  }
}

export type ToolPatch = Partial<
  Pick<
    AgentTool,
    | 'name'
    | 'argv'
    | 'processName'
    | 'description'
    | 'color'
    | 'displayOrder'
    | 'isDefault'
    | 'enabled'
    | 'aliases'
    | 'contextHook'
  >
>

export interface SessionSummary {
  id: string
  ownershipId: string
  tool: string
  name: string | null
  projectId: string | null
  tmuxServerId: string | null
  launchState: string
  lifecycleVersion: number
  origin: string
  createdAt: number
}

/**
 * Tether's catalog. One daemon process per instance is the only writer (the
 * control socket's liveness check refuses a second daemon); WAL keeps reads
 * available to diagnostics. All multi-row writes use BEGIN IMMEDIATE.
 */
export class Store {
  readonly db: DatabaseSync

  constructor(path: string, now: () => number = Date.now) {
    if (path !== ':memory:') {
      mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
      chmodSync(dirname(path), 0o700)
    }
    this.db = new DatabaseSync(path)
    this.db.exec('PRAGMA busy_timeout = 2000; PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON')
    this.migrate(now())
  }

  close(): void {
    this.db.close()
  }

  schemaVersion(): number {
    const row = this.db.prepare('SELECT max(version) AS version FROM schema_version').get() as {
      version: number | null
    }
    return row.version ?? 0
  }

  private migrate(now: number): void {
    this.db.exec(
      'CREATE TABLE IF NOT EXISTS schema_version (version INTEGER PRIMARY KEY, applied_at INTEGER NOT NULL)',
    )
    const current = this.schemaVersion()
    if (current > SCHEMA_VERSION) {
      throw new Error(
        `database schema ${current} is newer than this Tether build (${SCHEMA_VERSION}); refusing to start`,
      )
    }
    if (current === SCHEMA_VERSION) return
    this.transaction(() => {
      // v1: the initial schema plus seeded tools.
      this.db.exec(TMUX_SERVERS_TABLE_SQL)
      this.db.exec(SESSIONS_TABLE_SQL)
      this.db.exec(ROOT_REQUESTS_TABLE_SQL)
      this.db.exec(AGENT_TOOLS_TABLE_SQL)
      this.db.exec(INDEXES_SQL)
      for (const seed of DEFAULT_TOOLS) this.insertTool(seed, now)
      this.db.prepare('INSERT INTO schema_version (version, applied_at) VALUES (?, ?)').run(1, now)
    })
  }

  transaction<T>(work: () => T): T {
    this.db.exec('BEGIN IMMEDIATE')
    try {
      const result = work()
      this.db.exec('COMMIT')
      return result
    } catch (error) {
      this.db.exec('ROLLBACK')
      throw error
    }
  }

  // --- agent tools ---------------------------------------------------------

  listTools(options: { enabledOnly?: boolean } = {}): AgentTool[] {
    const where = options.enabledOnly ? 'WHERE enabled = 1' : ''
    const rows = this.db
      .prepare(`SELECT * FROM agent_tools ${where} ORDER BY display_order, name`)
      .all() as unknown as RawTool[]
    return rows.map(toTool)
  }

  getTool(idOrSlug: string): AgentTool | undefined {
    const raw = this.db
      .prepare('SELECT * FROM agent_tools WHERE id = ? OR slug = ?')
      .get(idOrSlug, idOrSlug) as RawTool | undefined
    return raw ? toTool(raw) : undefined
  }

  /** Resolve a slug or alias (A-Term `claude`) to its tool. */
  resolveTool(slugOrAlias: string): AgentTool | undefined {
    return (
      this.getTool(slugOrAlias) ??
      this.listTools().find((tool) => tool.aliases.includes(slugOrAlias))
    )
  }

  /** The default enabled tool, else the first enabled tool by order. */
  defaultTool(): AgentTool | undefined {
    const enabled = this.listTools({ enabledOnly: true })
    return enabled.find((tool) => tool.isDefault) ?? enabled[0]
  }

  private assertNamesFree(slug: string, aliases: readonly string[], exceptId: string | null): void {
    for (const tool of this.listTools()) {
      if (tool.id === exceptId) continue
      const taken = new Set([tool.slug, ...tool.aliases])
      if (taken.has(slug) || aliases.some((alias) => taken.has(alias))) {
        throw new ToolValidationError('slug_conflict')
      }
    }
  }

  private insertTool(seed: ToolSeed, now: number): AgentTool {
    const id = randomUUID()
    this.db
      .prepare(
        `INSERT INTO agent_tools (id, slug, name, argv, process_name, description, color,
           display_order, is_default, enabled, aliases, context_hook, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        seed.slug,
        seed.name,
        JSON.stringify(seed.argv),
        seed.processName,
        seed.description,
        seed.color,
        seed.displayOrder,
        seed.isDefault ? 1 : 0,
        seed.enabled ? 1 : 0,
        JSON.stringify(seed.aliases),
        seed.contextHook,
        now,
        now,
      )
    return this.getTool(id) as AgentTool
  }

  createTool(seed: ToolSeed, now = Date.now()): AgentTool {
    validateToolFields(seed)
    if (!SLUG_RE.test(seed.slug)) throw new ToolValidationError('invalid_slug')
    return this.transaction(() => {
      this.assertNamesFree(seed.slug, seed.aliases, null)
      if (seed.isDefault) this.db.exec('UPDATE agent_tools SET is_default = 0 WHERE is_default = 1')
      return this.insertTool(seed, now)
    })
  }

  /** Slug is immutable after creation. */
  updateTool(idOrSlug: string, patch: ToolPatch, now = Date.now()): AgentTool | undefined {
    validateToolFields(patch)
    return this.transaction(() => {
      const existing = this.getTool(idOrSlug)
      if (!existing) return undefined
      if (patch.aliases) this.assertNamesFree(existing.slug, patch.aliases, existing.id)
      if (patch.isDefault === true) {
        this.db
          .prepare('UPDATE agent_tools SET is_default = 0 WHERE is_default = 1 AND id <> ?')
          .run(existing.id)
      }
      const next = { ...existing, ...patch }
      this.db
        .prepare(
          `UPDATE agent_tools SET name = ?, argv = ?, process_name = ?, description = ?, color = ?,
             display_order = ?, is_default = ?, enabled = ?, aliases = ?, context_hook = ?,
             updated_at = max(?, created_at)
           WHERE id = ?`,
        )
        .run(
          next.name,
          JSON.stringify(next.argv),
          next.processName,
          next.description,
          next.color,
          next.displayOrder,
          next.isDefault ? 1 : 0,
          next.enabled ? 1 : 0,
          JSON.stringify(next.aliases),
          next.contextHook,
          now,
          existing.id,
        )
      return this.getTool(existing.id)
    })
  }

  /** Refuses the default tool and any tool a catalogued session still runs. */
  deleteTool(idOrSlug: string): 'deleted' | 'absent' | 'default_tool' | 'tool_in_use' {
    return this.transaction(() => {
      const tool = this.getTool(idOrSlug)
      if (!tool) return 'absent'
      if (tool.isDefault) return 'default_tool'
      const names = [tool.slug, ...tool.aliases]
      const inUse = this.db
        .prepare(
          `SELECT 1 FROM sessions WHERE tool IN (${names.map(() => '?').join(', ')}) LIMIT 1`,
        )
        .get(...names)
      if (inUse) return 'tool_in_use'
      this.db.prepare('DELETE FROM agent_tools WHERE id = ?').run(tool.id)
      return 'deleted'
    })
  }

  // --- sessions (read side; lifecycle writes arrive in Phase 3) ------------

  listSessions(): SessionSummary[] {
    const rows = this.db
      .prepare(
        `SELECT id, session_id, tool, name, project_id, tmux_server_id, launch_state,
           lifecycle_version, origin, created_at
         FROM sessions ORDER BY seq, id`,
      )
      .all() as {
      id: string
      session_id: string | null
      tool: string
      name: string | null
      project_id: string | null
      tmux_server_id: string | null
      launch_state: string
      lifecycle_version: number
      origin: string
      created_at: number
    }[]
    return rows.map((row) => ({
      id: row.id,
      ownershipId: row.session_id || `aico-widget-${row.id}`,
      tool: row.tool,
      name: row.name,
      projectId: row.project_id,
      tmuxServerId: row.tmux_server_id,
      launchState: row.launch_state,
      lifecycleVersion: row.lifecycle_version,
      origin: row.origin,
      createdAt: row.created_at,
    }))
  }

  counts(): { sessions: number; tmuxServersActive: number; rootRequests: number } {
    const one = (sql: string) => (this.db.prepare(sql).get() as { n: number }).n
    return {
      sessions: one('SELECT count(*) AS n FROM sessions'),
      tmuxServersActive: one("SELECT count(*) AS n FROM tmux_servers WHERE phase = 'active'"),
      rootRequests: one('SELECT count(*) AS n FROM root_requests'),
    }
  }
}

function validateToolFields(fields: ToolPatch): void {
  if (fields.name !== undefined && (fields.name.trim().length === 0 || fields.name.length > 100))
    throw new ToolValidationError('invalid_name')
  if (fields.argv !== undefined) validateArgv(fields.argv)
  if (fields.processName !== undefined && fields.processName.length > 100)
    throw new ToolValidationError('invalid_process_name')
  if (fields.color !== undefined && fields.color !== null && fields.color.length > 20)
    throw new ToolValidationError('invalid_color')
  if (fields.displayOrder !== undefined && !Number.isSafeInteger(fields.displayOrder))
    throw new ToolValidationError('invalid_display_order')
  if (
    fields.aliases !== undefined &&
    (!Array.isArray(fields.aliases) || fields.aliases.some((alias) => !SLUG_RE.test(alias)))
  )
    throw new ToolValidationError('invalid_aliases')
  if (
    fields.contextHook !== undefined &&
    fields.contextHook !== null &&
    !isContextHook(fields.contextHook)
  )
    throw new ToolValidationError('invalid_context_hook')
}
