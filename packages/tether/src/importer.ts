// `tether import-aico`: copy Aico's lifecycle catalog into a Tether instance.
//
// * The source is always an explicit path (`--from`), normally an archived
//   pre-Tether aico.db; it is opened read-only and is never modified.
// * Copied: every tmux_servers row, every root_requests row (tombstones
//   included), and the identity columns of every internal widget into
//   `sessions`. External (`external_tmux_*`) widgets are skipped. View columns
//   (bounds, display, open) and settings stay in Aico.
// * Values are copied unchanged, so a generation a client read from Aico stays
//   valid against the imported row.
// * Idempotent: rows already present in Tether are never overwritten. An
//   identical row is reported `same`; a row Tether has since changed is
//   reported `kept` (Tether is authoritative after import).
// * One transaction: any failure (for example a second live managed server
//   generation) rolls back everything.
// * Dry-run by default; `apply` writes.

import { existsSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import type { Store } from './store'

type Row = Record<string, unknown>

const SERVER_COLUMNS = [
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
] as const

const ROOT_COLUMNS = [
  'request_id',
  'digest',
  'widget_id',
  'logical_session_id',
  'role',
  'lead_root_reference',
  'facet_capsule_ref',
  'created_at',
] as const

/** Aico `widgets` identity columns, identical names in Tether `sessions`. */
const SESSION_COLUMNS = [
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
] as const

export type ImportAction = 'insert' | 'same' | 'kept' | 'skip-external'

export interface ImportEntry {
  table: 'tmux_servers' | 'root_requests' | 'sessions'
  key: string
  action: ImportAction
  /** Columns whose values differ when `kept`. Identifiers only, no values. */
  differs?: string[]
}

export interface ImportPlan {
  source: string
  entries: ImportEntry[]
  rows: {
    tmux_servers: Row[]
    root_requests: Row[]
    sessions: Row[]
  }
}

function pick(row: Row, columns: readonly string[]): Row {
  const out: Row = {}
  for (const column of columns) out[column] = row[column] ?? null
  return out
}

function differences(a: Row, b: Row, columns: readonly string[]): string[] {
  return columns.filter((column) => (a[column] ?? null) !== (b[column] ?? null))
}

/** Open aico.db strictly read-only (no WAL checkpoint, no writes). */
export function openAicoReadOnly(path: string): DatabaseSync {
  if (!existsSync(path)) throw new Error(`Aico database not found: ${path}`)
  return new DatabaseSync(path, { readOnly: true })
}

function readSource(source: DatabaseSync) {
  const servers = source
    .prepare('SELECT * FROM tmux_servers ORDER BY created_at, id')
    .all() as Row[]
  const roots = source
    .prepare('SELECT * FROM root_requests ORDER BY created_at, request_id')
    .all() as Row[]
  const widgets = source.prepare('SELECT * FROM widgets ORDER BY seq, id').all() as Row[]
  return { servers, roots, widgets }
}

function isExternal(widget: Row): boolean {
  return (
    widget.tmux_allocation_state === 'external' ||
    widget.external_tmux_socket != null ||
    widget.external_tmux_session != null
  )
}

/**
 * Compare aico.db with the target catalog. `target` may be null when the
 * instance has no database yet (dry-run never creates one).
 */
export function planImport(sourcePath: string, target: DatabaseSync | null): ImportPlan {
  const source = openAicoReadOnly(sourcePath)
  let data: ReturnType<typeof readSource>
  try {
    data = readSource(source)
  } finally {
    source.close()
  }
  const rootWidgets = new Set(data.roots.map((root) => root.widget_id as string))
  const entries: ImportEntry[] = []
  const rows: ImportPlan['rows'] = { tmux_servers: [], root_requests: [], sessions: [] }
  const existing = (sql: string, key: unknown): Row | undefined =>
    target ? (target.prepare(sql).get(key as string) as Row | undefined) : undefined

  const consider = (
    table: ImportEntry['table'],
    key: string,
    row: Row,
    current: Row | undefined,
    columns: readonly string[],
  ) => {
    if (!current) {
      entries.push({ table, key, action: 'insert' })
      rows[table].push(row)
      return
    }
    const differs = differences(row, current, columns)
    entries.push(
      differs.length ? { table, key, action: 'kept', differs } : { table, key, action: 'same' },
    )
  }

  for (const server of data.servers) {
    const row = pick(server, SERVER_COLUMNS)
    consider(
      'tmux_servers',
      row.id as string,
      row,
      existing('SELECT * FROM tmux_servers WHERE id = ?', row.id),
      SERVER_COLUMNS,
    )
  }
  for (const widget of data.widgets) {
    if (isExternal(widget)) {
      entries.push({ table: 'sessions', key: widget.id as string, action: 'skip-external' })
      continue
    }
    const row: Row = {
      ...pick(widget, SESSION_COLUMNS),
      origin: rootWidgets.has(widget.id as string) ? 'root' : 'aico',
      a_term_session_id: null,
    }
    consider(
      'sessions',
      row.id as string,
      row,
      existing('SELECT * FROM sessions WHERE id = ?', row.id),
      SESSION_COLUMNS,
    )
  }
  for (const root of data.roots) {
    const row = pick(root, ROOT_COLUMNS)
    consider(
      'root_requests',
      row.request_id as string,
      row,
      existing('SELECT * FROM root_requests WHERE request_id = ?', row.request_id),
      ROOT_COLUMNS,
    )
  }
  return { source: sourcePath, entries, rows }
}

function insertAll(db: DatabaseSync, table: string, rows: Row[]): void {
  if (rows.length === 0) return
  const columns = Object.keys(rows[0] as Row)
  const statement = db.prepare(
    `INSERT INTO ${table} (${columns.join(', ')}) VALUES (${columns.map(() => '?').join(', ')})`,
  )
  for (const row of rows) statement.run(...(columns.map((column) => row[column]) as never[]))
}

/** Apply a plan in ONE transaction. Rows are re-planned inside it so a
 * concurrent writer can never turn `insert` into an overwrite. */
export function applyImport(sourcePath: string, store: Store): ImportPlan {
  return store.transaction(() => {
    const plan = planImport(sourcePath, store.db)
    insertAll(store.db, 'tmux_servers', plan.rows.tmux_servers)
    insertAll(store.db, 'sessions', plan.rows.sessions)
    insertAll(store.db, 'root_requests', plan.rows.root_requests)
    return plan
  })
}

/** Dry-run against an instance database without creating or migrating it. */
export function planImportForPath(sourcePath: string, targetDbPath: string): ImportPlan {
  if (!existsSync(targetDbPath)) return planImport(sourcePath, null)
  const target = new DatabaseSync(targetDbPath, { readOnly: true })
  try {
    return planImport(sourcePath, target)
  } finally {
    target.close()
  }
}

export function summarize(plan: ImportPlan): Record<string, Record<ImportAction, number>> {
  const summary: Record<string, Record<ImportAction, number>> = {}
  for (const entry of plan.entries) {
    summary[entry.table] ??= { insert: 0, same: 0, kept: 0, 'skip-external': 0 }
    summary[entry.table][entry.action] += 1
  }
  return summary
}

/** Human diff: one line per row that would change or is notable. */
export function formatPlan(plan: ImportPlan, applied: boolean): string[] {
  const lines = [`${applied ? 'imported' : 'dry-run'} from ${plan.source}`]
  for (const [table, counts] of Object.entries(summarize(plan))) {
    lines.push(
      `  ${table.padEnd(14)} insert=${counts.insert} same=${counts.same} kept=${counts.kept}` +
        (counts['skip-external'] ? ` skip-external=${counts['skip-external']}` : ''),
    )
  }
  for (const entry of plan.entries) {
    if (entry.action === 'same') continue
    const sign = entry.action === 'insert' ? '+' : entry.action === 'kept' ? '~' : '-'
    const detail = entry.differs ? ` (Tether differs: ${entry.differs.join(', ')})` : ''
    lines.push(`  ${sign} ${entry.table} ${entry.key} ${entry.action}${detail}`)
  }
  if (!applied) lines.push('nothing written; re-run with --apply to import')
  return lines
}
