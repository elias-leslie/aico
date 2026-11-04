import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { openTasksDb } from './db'
import { Registry } from './projects'
import {
  importProjects,
  importTasks,
  type MigrationRule,
  type SfQuery,
  type SfRow,
  stQuery,
} from './summitflow-import'
import { TaskStore } from './tasks'

const project = (id: string, extra: SfRow = {}): SfRow => ({
  id,
  name: id.toUpperCase(),
  root_path: `/srv/${id}`,
  category: 'production',
  base_url: null,
  public_url: null,
  health_endpoint: '/health',
  frontend_port: 3000,
  backend_port: 3001,
  sidebar_rank: null,
  backend_dir: null,
  browser_scripts_dir: null,
  data_dir: null,
  agent_configs: { publication_mode: 'nightly' },
  test_config: {},
  created_at: '2026-05-20T00:32:31.784244+00:00',
  ...extra,
})

const task = (
  id: string,
  projectId: string,
  status: string,
  updated: string,
  extra: SfRow = {},
): SfRow => ({
  id,
  project_id: projectId,
  status,
  updated_at: updated,
  created_at: '2026-10-01T00:00:00+00:00',
  title: `title ${id}`,
  description: 'text',
  task_type: 'task',
  priority: 2,
  labels: ['a'],
  parent_task_id: null,
  started_at: null,
  completed_at: null,
  done_when: ['it works'],
  context: {},
  spirit_complexity: 'SIMPLE',
  ...extra,
})

/** A fake SummitFlow answering the few SELECTs the import makes, by what they mention. */
function fake(data: {
  projects: SfRow[]
  decisions?: SfRow[]
  events?: SfRow[]
  tasks?: SfRow[]
  subtasks?: SfRow[]
  logs?: SfRow[]
  deps?: SfRow[]
}): SfQuery {
  return (sql) => {
    if (sql.includes('FROM projects')) return data.projects
    if (sql.includes('project_retirement_decisions')) return data.decisions ?? []
    if (sql.includes('project_lifecycle_events')) return data.events ?? []
    const ids = [...sql.matchAll(/'(task-[a-z0-9]+)'/g)].map((m) => m[1])
    const only = (rows: SfRow[] | undefined, key: string) =>
      (rows ?? []).filter((row) => ids.includes(String(row[key])))
    if (sql.startsWith('SELECT count(*)')) {
      const table = /FROM (\w+)/.exec(sql)?.[1]
      const rows = {
        task_subtasks: data.subtasks,
        events: data.logs,
        task_dependencies: data.deps,
      }[table as string]
      return [{ n: only(rows, table === 'events' ? 'trace_id' : 'task_id').length }]
    }
    if (sql.includes('FROM task_subtasks')) return only(data.subtasks, 'task_id')
    if (sql.includes('FROM events')) return only(data.logs, 'trace_id')
    if (sql.includes('FROM task_dependencies')) return only(data.deps, 'task_id')
    if (sql.includes('t.id IN'))
      return (data.tasks ?? []).filter((row) => ids.includes(String(row.id)))
    return data.tasks ?? []
  }
}

describe('projects import', () => {
  const sf = fake({
    projects: [project('aico'), project('old'), project('neri')],
    decisions: [{ project_id: 'old', reason: 'merged' }],
    events: [
      {
        project_id: 'old',
        action: 'retired',
        owner_email: 'o@x',
        reason: 'merged',
        recorded_at: '2026-10-23T17:29:20.786793+00:00',
      },
      {
        project_id: 'gone-fixture',
        action: 'retired',
        owner_email: null,
        reason: null,
        recorded_at: '2026-10-10T13:50:57+00:00',
      },
    ],
  })

  it('carries the open projects and the events of known ones, with matching hashes', () => {
    const db = openTasksDb(':memory:')
    const report = importProjects(db, sf, false)
    expect(report).toMatchObject({
      sourceProjects: 3,
      retiredInSource: 1,
      carried: 2,
      added: 2,
      updated: 0,
    })
    expect(report.events).toEqual({ source: 1, added: 1 })
    expect(report.hash.match).toBe(true)
    expect(report.eventHash.match).toBe(true)
    const registry = new Registry(db)
    expect(registry.list().map((p) => p.id)).toEqual(['aico', 'neri'])
    expect(registry.get('aico')?.agent_configs).toEqual({ publication_mode: 'nightly' })
  })

  it('a second run changes nothing, and a dry run writes nothing', () => {
    const db = openTasksDb(':memory:')
    const dry = importProjects(db, sf, true)
    expect(dry).toMatchObject({ dryRun: true, added: 2 })
    expect(dry.hash.match).toBe(false)
    expect(new Registry(db).list()).toEqual([])
    importProjects(db, sf, false)
    const again = importProjects(db, sf, false)
    expect(again).toMatchObject({ added: 0, updated: 0, unchanged: 2 })
    expect(again.events.added).toBe(0)
    expect(again.hash.match).toBe(true)
  })

  it('picks up a changed source row and a newly retired project, and keeps a retirement made here', () => {
    const db = openTasksDb(':memory:')
    importProjects(db, sf, false)
    new Registry(db).retire('neri', 'done here')
    const later = fake({
      projects: [project('aico', { name: 'Aico 2' }), project('old'), project('neri')],
      decisions: [
        { project_id: 'old', reason: 'merged' },
        { project_id: 'aico', reason: 'retired in source' },
      ],
    })
    const report = importProjects(db, later, false)
    expect(report).toMatchObject({ updated: 0, retiredHere: 1 })
    const registry = new Registry(db)
    expect(registry.get('aico')?.retired_reason).toBe('retired in source')
    expect(registry.get('neri')?.retired_reason).toBe('done here')
  })
})

describe('tasks import', () => {
  const rule: MigrationRule = {
    statuses: ['pending', 'paused', 'running'],
    updatedSince: '2026-10-25',
    excludeProjects: ['agent-hub'],
  }
  const data = {
    projects: [project('aico'), project('neri'), project('agent-hub'), project('old')],
    decisions: [{ project_id: 'old', reason: 'merged' }],
    tasks: [
      task('task-aa', 'aico', 'pending', '2026-11-01T00:00:00+00:00'),
      task('task-ab', 'aico', 'completed', '2026-11-01T00:00:00+00:00'),
      task('task-ac', 'aico', 'pending', '2026-10-01T00:00:00+00:00'),
      task('task-ad', 'aico', 'paused', '2026-10-25T00:00:00+00:00'),
      task('task-ba', 'neri', 'pending', '2026-11-02T00:00:00+00:00'),
      task('task-ca', 'agent-hub', 'pending', '2026-11-02T00:00:00+00:00'),
      task('task-da', 'old', 'pending', '2026-11-02T00:00:00+00:00'),
    ],
    subtasks: [
      {
        task_id: 'task-aa',
        subtask_id: '1.1',
        phase: 'implementation',
        description: 'do',
        passes: true,
        display_order: 0,
        passed_at: '2026-11-01T00:00:00+00:00',
      },
      {
        task_id: 'task-aa',
        subtask_id: '1.2',
        phase: null,
        description: 'more',
        passes: false,
        display_order: 1,
        passed_at: null,
      },
    ],
    logs: [{ trace_id: 'task-aa', message: 'did a thing', timestamp: '2026-11-01T01:00:00+00:00' }],
    deps: [{ task_id: 'task-ad', depends_on_task_id: 'task-aa' }],
  }

  function prepared() {
    const db = openTasksDb(':memory:')
    importProjects(db, fake(data), false)
    return db
  }

  it('applies the rule: status, date and project; counts per project', () => {
    const db = prepared()
    const report = importTasks(db, fake(data), rule, true)
    expect(report.selected).toEqual({ aico: 2, neri: 1 })
    expect(report.skippedProjects).toEqual({ 'agent-hub': 1, old: 1 })
    expect(report).toMatchObject({ selectedTotal: 3, subtasks: 2, log: 1, blockers: 1 })
    expect(new TaskStore(db).list({ project_id: 'aico' })).toEqual([])
  })

  it('carries tasks with subtasks, acceptance, log and blockers, and a rerun is a no-op', () => {
    const db = prepared()
    const report = importTasks(db, fake(data), rule, false)
    expect(report).toMatchObject({ added: 3, unchanged: 0 })
    const store = new TaskStore(db)
    const carried = store.require('task-aa')
    expect(carried).toMatchObject({
      status: 'pending',
      acceptance: ['it works'],
      labels: ['a'],
      imported_from: 'summitflow',
    })
    expect(store.subtasks('task-aa').map((s) => [s.ref, s.status])).toEqual([
      ['1.1', 'completed'],
      ['1.2', 'pending'],
    ])
    expect(store.log('task-aa').map((l) => l.message)).toEqual(['did a thing'])
    expect(store.blockers('task-ad')).toEqual([{ id: 'task-aa', status: 'pending' }])
    expect(importTasks(db, fake(data), rule, false)).toMatchObject({
      added: 0,
      updated: 0,
      unchanged: 3,
    })
    expect(store.log('task-aa')).toHaveLength(1)
  })

  it('follows SummitFlow for a carried task, but never overwrites a newer change made here', () => {
    const db = prepared()
    importTasks(db, fake(data), rule, false)
    const store = new TaskStore(db, () => Date.parse('2026-12-01T00:00:00Z'))
    store.claim('task-ba', { owner: 'ann' })
    const moved = {
      ...data,
      tasks: data.tasks.map((row) =>
        row.id === 'task-aa'
          ? { ...row, status: 'completed', updated_at: '2026-11-03T00:00:00+00:00' }
          : row.id === 'task-ba'
            ? { ...row, title: 'renamed there', updated_at: '2026-11-03T00:00:00+00:00' }
            : row,
      ),
    }
    const report = importTasks(db, fake(moved), rule, false)
    expect(report).toMatchObject({ updated: 1, keptNewerHere: 1 })
    expect(store.require('task-aa').status).toBe('completed')
    expect(store.require('task-ba')).toMatchObject({ status: 'running', title: 'title task-ba' })
  })
})

describe('stQuery', () => {
  const secret = 'NERI ROW TITLE'
  const withDetails = (body: string) => {
    const root = mkdtempSync(join(tmpdir(), 'sfq-'))
    mkdirSync(join(root, '.dev-tools'))
    const rel = '.dev-tools/db-query-1-details.txt'
    writeFileSync(join(root, rel), body)
    return { root, file: join(root, rel), pointer: `DB:OK:1|lines=1|details:${rel}|hint:x` }
  }

  it('removes the details file and never quotes row text when the answer is unreadable', () => {
    const { root, file, pointer } = withDetails(`[{"title": "${secret}", `)
    const query = stQuery(root, () => pointer)
    let message = ''
    try {
      query('SELECT 1')
    } catch (error) {
      message = (error as Error).message
    }
    expect(message).toMatch(/unreadable JSON \(\d+ bytes\)/)
    expect(message).not.toContain(secret)
    expect(existsSync(file)).toBe(false)
  })

  it('removes the details file when the run itself fails', () => {
    const { root, file, pointer } = withDetails(`[{"title": "${secret}"}]`)
    const query = stQuery(root, () => {
      throw Object.assign(new Error(`Command failed: ${secret}`), { status: 1, stdout: pointer })
    })
    expect(() => query('SELECT 1')).toThrow(/^st db query failed \(exit 1\): DB:OK:1$/)
    expect(existsSync(file)).toBe(false)
  })

  it('reads and removes a details file on success', () => {
    const { root, file, pointer } = withDetails('[{"id": "p1"}]')
    expect(stQuery(root, () => pointer)('SELECT 1')).toEqual([{ id: 'p1' }])
    expect(existsSync(file)).toBe(false)
  })
})
