// Carries SummitFlow's projects registry and light tasks into tasks.db. Both steps can be
// re-run until the `st` alias cutover (M10d): a second run changes only what SummitFlow
// changed since, never what Aico changed later, and says what it did in counts. SummitFlow is
// read through `st db` (read-only). Nothing here prints a title or any task text: Neri's rows
// are copied like any other and only ever counted.

import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readFileSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'
import { transaction } from '@aico/store'
import type { Database } from './db'

export type SfRow = Record<string, unknown>
/** Runs one SELECT against SummitFlow and returns its rows. */
export type SfQuery = (sql: string) => SfRow[]

export interface MigrationRule {
  statuses: string[]
  /** Date (YYYY-MM-DD): only tasks updated on or after it. */
  updatedSince: string
  excludeProjects: string[]
}

export function loadRule(path: string): MigrationRule {
  return JSON.parse(readFileSync(path, 'utf8')) as MigrationRule
}

const SF_ROOT = '/srv/workspaces/projects/summitflow'

/**
 * `st db query` keeps answers over ~1.5 KB in a details file under the project's .dev-tools and
 * prints a pointer; that file is read here and removed (it is regenerable scratch).
 */
export function stQuery(root = SF_ROOT): SfQuery {
  return (sql) => {
    const wrapped = `SELECT coalesce(jsonb_agg(t), '[]'::jsonb) FROM (${sql}) t`
    let out = execFileSync('st', ['db', '-P', 'summitflow', 'query', '-t', wrapped], {
      cwd: root,
      encoding: 'utf8',
      maxBuffer: 256 * 1024 * 1024,
    }).trim()
    const pointer = /^DB:OK:\d+\|lines=\d+\|details:([^|]+)\|/.exec(out)
    if (pointer) {
      const file = join(root, pointer[1] as string)
      out = readFileSync(file, 'utf8').trim()
      unlinkSync(file)
    }
    if (!out.startsWith('[')) throw new Error(`st db query failed: ${out.slice(0, 160)}`)
    return JSON.parse(out) as SfRow[]
  }
}

const ms = (value: unknown): number | null =>
  value === null || value === undefined ? null : Date.parse(String(value))
const text = (value: unknown): string | null =>
  value === null || value === undefined ? null : String(value)
const num = (value: unknown): number | null =>
  value === null || value === undefined ? null : Number(value)
const json = (value: unknown, fallback: string): string =>
  value === null || value === undefined ? fallback : JSON.stringify(value)
const digest = (items: unknown[]): string =>
  createHash('sha256').update(JSON.stringify(items)).digest('hex')
const quote = (value: string) => `'${value.replaceAll("'", "''")}'`

// -- projects ------------------------------------------------------------------------------

const PROJECT_FIELDS = [
  'id',
  'name',
  'root_path',
  'category',
  'base_url',
  'public_url',
  'health_endpoint',
  'frontend_port',
  'backend_port',
  'sidebar_rank',
  'backend_dir',
  'browser_scripts_dir',
  'data_dir',
  'agent_configs',
  'test_config',
  'created_at',
] as const

function mapProject(row: SfRow): Record<string, unknown> {
  return {
    id: String(row.id),
    name: String(row.name),
    root_path: text(row.root_path),
    category: text(row.category),
    base_url: text(row.base_url),
    public_url: text(row.public_url),
    health_endpoint: text(row.health_endpoint),
    frontend_port: num(row.frontend_port),
    backend_port: num(row.backend_port),
    sidebar_rank: num(row.sidebar_rank),
    backend_dir: text(row.backend_dir),
    browser_scripts_dir: text(row.browser_scripts_dir),
    data_dir: text(row.data_dir),
    agent_configs: json(row.agent_configs, '{}'),
    test_config: json(row.test_config, '{}'),
    created_at: ms(row.created_at),
  }
}

/** A stored project row in the same shape as mapProject, so both sides hash alike. */
function storedProject(db: Database, id: string): Record<string, unknown> | null {
  const row = db
    .prepare(`SELECT ${PROJECT_FIELDS.join(', ')} FROM projects WHERE id = ?`)
    .get(id) as Record<string, unknown> | undefined
  return row ? { ...row } : null
}

const canonical = (row: Record<string, unknown>) =>
  PROJECT_FIELDS.map((field) => [field, row[field]])

export interface ProjectsReport {
  dryRun: boolean
  sourceProjects: number
  retiredInSource: number
  carried: number
  added: number
  updated: number
  unchanged: number
  retiredHere: number
  events: { source: number; added: number }
  hash: { source: string; target: string; match: boolean }
  eventHash: { source: string; target: string; match: boolean }
}

export function importProjects(db: Database, query: SfQuery, dryRun: boolean): ProjectsReport {
  const rows = query('SELECT * FROM projects ORDER BY id')
  const decisions = query('SELECT project_id, reason FROM project_retirement_decisions')
  const retiredIds = new Map(
    decisions.map((row) => [String(row.project_id), String(row.reason ?? '')]),
  )
  const known = new Set(rows.map((row) => String(row.id)))
  const events = query(
    'SELECT project_id, action, owner_email, reason, recorded_at FROM project_lifecycle_events ORDER BY id',
  ).filter((row) => known.has(String(row.project_id)))
  const mappedEvents = events.map((row) => ({
    project_id: String(row.project_id),
    action: String(row.action) === 'retired' ? 'retired' : 'reactivated',
    owner_email: text(row.owner_email),
    reason: text(row.reason),
    recorded_at: ms(row.recorded_at),
  }))
  const report: ProjectsReport = {
    dryRun,
    sourceProjects: rows.length,
    retiredInSource: retiredIds.size,
    carried: 0,
    added: 0,
    updated: 0,
    unchanged: 0,
    retiredHere: 0,
    events: { source: mappedEvents.length, added: 0 },
    hash: { source: '', target: '', match: false },
    eventHash: { source: '', target: '', match: false },
  }
  const carried = rows.filter((row) => !retiredIds.has(String(row.id))).map(mapProject)
  report.carried = carried.length
  const existsEvent = db.prepare(
    'SELECT 1 FROM project_events WHERE project_id = ? AND action = ? AND recorded_at = ?',
  )
  const apply = () => {
    for (const project of carried) {
      const stored = storedProject(db, String(project.id))
      if (!stored) {
        report.added += 1
        if (!dryRun)
          db.prepare(
            `INSERT INTO projects (${PROJECT_FIELDS.join(', ')}) VALUES (${PROJECT_FIELDS.map(() => '?').join(', ')})`,
          ).run(...(PROJECT_FIELDS.map((field) => project[field]) as never[]))
      } else if (digest(canonical(stored)) === digest(canonical(project))) {
        report.unchanged += 1
      } else {
        report.updated += 1
        if (!dryRun)
          db.prepare(
            `UPDATE projects SET ${PROJECT_FIELDS.filter((f) => f !== 'id')
              .map((f) => `${f} = ?`)
              .join(', ')} WHERE id = ?`,
          ).run(
            ...(PROJECT_FIELDS.filter((f) => f !== 'id').map((f) => project[f]) as never[]),
            project.id as string,
          )
      }
    }
    // A project SummitFlow has retired since an earlier run leaves the open list here too.
    for (const [id, reason] of retiredIds) {
      const mine = db.prepare('SELECT retired_at FROM projects WHERE id = ?').get(id) as
        | { retired_at: number | null }
        | undefined
      if (mine && mine.retired_at === null) {
        report.retiredHere += 1
        if (!dryRun)
          db.prepare('UPDATE projects SET retired_at = ?, retired_reason = ? WHERE id = ?').run(
            Date.now(),
            reason,
            id,
          )
      }
    }
    for (const event of mappedEvents) {
      if (existsEvent.get(event.project_id, event.action, event.recorded_at)) continue
      report.events.added += 1
      if (!dryRun)
        db.prepare(
          'INSERT INTO project_events (project_id, action, owner_email, reason, recorded_at) VALUES (?, ?, ?, ?, ?)',
        ).run(
          event.project_id,
          event.action,
          event.owner_email,
          event.reason,
          event.recorded_at as number,
        )
    }
  }
  if (dryRun) apply()
  else transaction(db, apply)

  const sourceHash = digest(carried.map(canonical))
  const here = carried.map((project) => storedProject(db, String(project.id)))
  const targetHash = digest(here.map((row) => (row ? canonical(row) : null)))
  report.hash = { source: sourceHash, target: targetHash, match: sourceHash === targetHash }
  const eventKey = (e: Record<string, unknown>) => [
    e.project_id,
    e.action,
    e.owner_email,
    e.reason,
    e.recorded_at,
  ]
  const sortKeys = (items: unknown[][]) =>
    items.sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)))
  const have = db
    .prepare('SELECT project_id, action, owner_email, reason, recorded_at FROM project_events')
    .all() as Record<string, unknown>[]
  const wanted = new Set(mappedEvents.map((e) => JSON.stringify(eventKey(e))))
  const sourceEvents = digest(sortKeys(mappedEvents.map(eventKey)))
  const targetEvents = digest(
    sortKeys(have.map(eventKey).filter((k) => wanted.has(JSON.stringify(k)))),
  )
  report.eventHash = {
    source: sourceEvents,
    target: targetEvents,
    match: sourceEvents === targetEvents,
  }
  return report
}

// -- tasks ---------------------------------------------------------------------------------

export interface TasksReport {
  dryRun: boolean
  rule: MigrationRule
  /** Tasks the rule selects, per project (counts only). */
  selected: Record<string, number>
  selectedTotal: number
  /** Tasks SummitFlow has per project, selected or not. */
  sourcePerProject: Record<string, number>
  skippedProjects: Record<string, number>
  subtasks: number
  log: number
  blockers: number
  added: number
  updated: number
  unchanged: number
  keptNewerHere: number
}

const CHUNK = 20

export function importTasks(
  db: Database,
  query: SfQuery,
  rule: MigrationRule,
  dryRun: boolean,
): TasksReport {
  const index = query('SELECT id, project_id, status, updated_at FROM tasks ORDER BY id')
  const open = new Set(
    (db.prepare('SELECT id FROM projects WHERE retired_at IS NULL').all() as { id: string }[]).map(
      (row) => row.id,
    ),
  )
  const imported = new Set(
    (
      db.prepare("SELECT id FROM tasks WHERE imported_from = 'summitflow'").all() as {
        id: string
      }[]
    ).map((row) => row.id),
  )
  const since = Date.parse(rule.updatedSince)
  const sourcePerProject: Record<string, number> = {}
  const skippedProjects: Record<string, number> = {}
  const selected: Record<string, number> = {}
  const picked: string[] = []
  for (const row of index) {
    const project = String(row.project_id)
    sourcePerProject[project] = (sourcePerProject[project] ?? 0) + 1
    const stays = open.has(project) && !rule.excludeProjects.includes(project)
    const fresh = rule.statuses.includes(String(row.status)) && (ms(row.updated_at) ?? 0) >= since
    if (!stays) {
      if (fresh) skippedProjects[project] = (skippedProjects[project] ?? 0) + 1
      continue
    }
    // A task already carried follows SummitFlow whatever its status now, until the cutover.
    if (fresh || imported.has(String(row.id))) {
      selected[project] = (selected[project] ?? 0) + 1
      picked.push(String(row.id))
    }
  }
  const report: TasksReport = {
    dryRun,
    rule,
    selected,
    selectedTotal: picked.length,
    sourcePerProject,
    skippedProjects,
    subtasks: 0,
    log: 0,
    blockers: 0,
    added: 0,
    updated: 0,
    unchanged: 0,
    keptNewerHere: 0,
  }
  const list = (ids: string[]) => ids.map(quote).join(', ')
  const countIn = (table: string, column: string, extra = '') =>
    picked.length
      ? Number(
          query(
            `SELECT count(*) AS n FROM ${table} WHERE ${column} IN (${list(picked)}) ${extra}`,
          )[0]?.n ?? 0,
        )
      : 0
  report.subtasks = countIn('task_subtasks', 'task_id')
  report.log = countIn('events', 'trace_id', "AND event_type IN ('log', 'progress')")
  report.blockers = countIn('task_dependencies', 'task_id')
  if (dryRun) return report

  for (let at = 0; at < picked.length; at += CHUNK) {
    const ids = picked.slice(at, at + CHUNK)
    const tasks = query(
      `SELECT t.*, s.done_when, s.context, s.complexity AS spirit_complexity FROM tasks t
       LEFT JOIN task_spirit s ON s.task_id = t.id WHERE t.id IN (${list(ids)})`,
    )
    const subtasks = query(
      `SELECT * FROM task_subtasks WHERE task_id IN (${list(ids)}) ORDER BY task_id, display_order`,
    )
    const logs = query(
      `SELECT trace_id, message, timestamp FROM events
       WHERE trace_id IN (${list(ids)}) AND event_type IN ('log', 'progress') AND message IS NOT NULL
       ORDER BY timestamp, id`,
    )
    const blockers = query(
      `SELECT task_id, depends_on_task_id FROM task_dependencies WHERE task_id IN (${list(ids)})`,
    )
    transaction(db, () => {
      for (const row of tasks) carryTask(db, row, subtasks, logs, blockers, report)
    })
  }
  return report
}

const TASK_FIELDS = [
  'project_id',
  'parent_task_id',
  'title',
  'description',
  'status',
  'task_type',
  'priority',
  'labels',
  'complexity',
  'acceptance',
  'plan',
  'created_at',
  'updated_at',
  'started_at',
  'completed_at',
] as const

function carryTask(
  db: Database,
  row: SfRow,
  subtasks: SfRow[],
  logs: SfRow[],
  blockers: SfRow[],
  report: TasksReport,
): void {
  const id = String(row.id)
  const context = row.context && Object.keys(row.context as object).length ? row.context : null
  const mapped: Record<string, unknown> = {
    project_id: String(row.project_id),
    parent_task_id: text(row.parent_task_id),
    title: String(row.title),
    description: String(row.description ?? ''),
    status: String(row.status),
    task_type: String(row.task_type ?? 'task'),
    priority: num(row.priority) ?? 2,
    labels: json(row.labels, '[]'),
    complexity: text(row.spirit_complexity ?? row.complexity),
    acceptance: json(row.done_when, '[]'),
    plan: context ? JSON.stringify({ context }) : null,
    created_at: ms(row.created_at),
    updated_at: ms(row.updated_at),
    started_at: ms(row.started_at),
    completed_at: ms(row.completed_at),
  }
  const mine = db.prepare(`SELECT ${TASK_FIELDS.join(', ')} FROM tasks WHERE id = ?`).get(id) as
    | Record<string, unknown>
    | undefined
  if (!mine) {
    report.added += 1
    db.prepare(
      `INSERT INTO tasks (id, ${TASK_FIELDS.join(', ')}, imported_from) VALUES (?, ${TASK_FIELDS.map(() => '?').join(', ')}, 'summitflow')`,
    ).run(id, ...(TASK_FIELDS.map((field) => mapped[field]) as never[]))
  } else if (TASK_FIELDS.every((field) => mine[field] === mapped[field])) {
    report.unchanged += 1
  } else if ((mine.updated_at as number) > (mapped.updated_at as number)) {
    report.keptNewerHere += 1
    return
  } else {
    report.updated += 1
    db.prepare(
      `UPDATE tasks SET ${TASK_FIELDS.map((f) => `${f} = ?`).join(', ')} WHERE id = ?`,
    ).run(...(TASK_FIELDS.map((field) => mapped[field]) as never[]), id)
  }
  const mineSubtasks = subtasks.filter((subtask) => String(subtask.task_id) === id)
  db.prepare('DELETE FROM subtasks WHERE task_id = ?').run(id)
  for (const subtask of mineSubtasks)
    db.prepare(
      `INSERT INTO subtasks (task_id, ref, phase, description, status, position, completed_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      id,
      String(subtask.subtask_id),
      text(subtask.phase),
      String(subtask.description ?? ''),
      subtask.passes ? 'completed' : 'pending',
      num(subtask.display_order) ?? 0,
      ms(subtask.passed_at),
    )
  const haveLog = db.prepare('SELECT 1 FROM task_log WHERE task_id = ? AND at = ? AND message = ?')
  for (const entry of logs.filter((log) => String(log.trace_id) === id)) {
    const at = ms(entry.timestamp) as number
    if (haveLog.get(id, at, String(entry.message))) continue
    db.prepare('INSERT INTO task_log (task_id, at, message) VALUES (?, ?, ?)').run(
      id,
      at,
      String(entry.message),
    )
  }
  for (const blocker of blockers.filter((b) => String(b.task_id) === id))
    db.prepare('INSERT OR IGNORE INTO task_blockers (task_id, blocked_by) VALUES (?, ?)').run(
      id,
      String(blocker.depends_on_task_id),
    )
}
