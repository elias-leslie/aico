// Tasks, subtasks (X.Y), claims, the task log and task-to-session links. A claim is one open
// row per task or subtask; releasing it keeps the row as history.

import { randomBytes } from 'node:crypto'
import { transaction } from '@aico/store'
import type { Database } from './db'

export type TaskStatus = 'pending' | 'running' | 'paused' | 'completed' | 'failed' | 'abandoned'

export interface Task {
  id: string
  project_id: string
  parent_task_id: string | null
  title: string
  description: string
  status: TaskStatus
  task_type: string
  priority: number
  labels: string[]
  complexity: string | null
  acceptance: string[]
  plan: Record<string, unknown> | null
  summary: string | null
  outcome: string | null
  created_at: number
  updated_at: number
  started_at: number | null
  completed_at: number | null
  imported_from: string | null
}

export interface Subtask {
  task_id: string
  ref: string
  phase: string | null
  description: string
  status: 'pending' | 'running' | 'completed'
  summary: string | null
  position: number
  completed_at: number | null
}

export interface Claim {
  id: number
  task_id: string
  subtask: string
  owner: string
  session_id: string | null
  claimed_at: number
  released_at: number | null
  release_reason: string | null
}

export interface SessionLink {
  task_id: string
  session_id: string
  tether_session: string | null
  linked_at: number
}

/** Who is acting: the claim owner, and the session to link when there is one. */
export interface Caller {
  owner: string
  session?: { id: string; tether?: string | null }
}

export class TaskError extends Error {}

const SUBTASK_REF = /^\d+\.\d+$/
/** `1.2` names a subtask (with --task); anything else is a task id. */
export const isSubtaskRef = (id: string) => SUBTASK_REF.test(id)

type Row = Record<string, unknown>

function toTask(row: Row): Task {
  return {
    ...(row as unknown as Task),
    labels: JSON.parse(String(row.labels)),
    acceptance: JSON.parse(String(row.acceptance)),
    plan: row.plan === null ? null : JSON.parse(String(row.plan)),
  }
}

export interface NewTask {
  project_id: string
  title: string
  description?: string
  task_type?: string
  priority?: number
  labels?: string[]
  complexity?: string | null
  acceptance?: string[]
  plan?: Record<string, unknown> | null
  parent_task_id?: string | null
  blocked_by?: string | null
  subtasks?: { description: string; phase?: string | null }[]
}

export interface ListFilter {
  project_id?: string
  status?: string
  task_type?: string
  priority?: number
  labels?: string[]
  limit?: number
}

const CLAIMABLE: TaskStatus[] = ['pending', 'paused', 'failed']

export class TaskStore {
  constructor(
    readonly db: Database,
    private readonly now: () => number = Date.now,
  ) {}

  // -- tasks ---------------------------------------------------------------------------------

  get(id: string): Task | null {
    const row = this.db.prepare('SELECT * FROM tasks WHERE id = ?').get(id) as Row | undefined
    return row ? toTask(row) : null
  }

  require(id: string): Task {
    const task = this.get(id)
    if (!task) throw new TaskError(`no task ${id}`)
    return task
  }

  create(input: NewTask): Task {
    const project = this.db
      .prepare('SELECT retired_at FROM projects WHERE id = ?')
      .get(input.project_id) as { retired_at: number | null } | undefined
    if (!project) throw new TaskError(`no project ${input.project_id}`)
    if (project.retired_at !== null) throw new TaskError(`project ${input.project_id} is retired`)
    if (!input.title.trim()) throw new TaskError('a task needs a title')
    if (input.parent_task_id) this.require(input.parent_task_id)
    if (input.blocked_by) this.require(input.blocked_by)
    const id = `task-${randomBytes(8).toString('hex')}`
    const now = this.now()
    return transaction(this.db, () => {
      this.db
        .prepare(
          `INSERT INTO tasks (id, project_id, parent_task_id, title, description, status, task_type,
             priority, labels, complexity, acceptance, plan, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          id,
          input.project_id,
          input.parent_task_id ?? null,
          input.title.trim(),
          input.description ?? '',
          input.task_type ?? 'task',
          input.priority ?? 2,
          JSON.stringify(input.labels ?? []),
          input.complexity ?? null,
          JSON.stringify(input.acceptance ?? []),
          input.plan ? JSON.stringify(input.plan) : null,
          now,
          now,
        )
      this.replaceSubtasks(id, input.subtasks ?? [])
      if (input.blocked_by)
        this.db
          .prepare('INSERT INTO task_blockers (task_id, blocked_by) VALUES (?, ?)')
          .run(id, input.blocked_by)
      return this.require(id)
    })
  }

  /** Replace a task's plan fields (`create --plan P --task ID`); claims and the log stay. */
  update(id: string, input: Partial<NewTask>): Task {
    const task = this.require(id)
    const merged = {
      ...task,
      ...Object.fromEntries(Object.entries(input).filter(([, v]) => v !== undefined)),
    }
    return transaction(this.db, () => {
      this.db
        .prepare(
          `UPDATE tasks SET title = ?, description = ?, task_type = ?, priority = ?, labels = ?,
             complexity = ?, acceptance = ?, plan = ?, updated_at = ? WHERE id = ?`,
        )
        .run(
          merged.title,
          merged.description ?? '',
          merged.task_type,
          merged.priority,
          JSON.stringify(merged.labels),
          merged.complexity ?? null,
          JSON.stringify(merged.acceptance),
          merged.plan ? JSON.stringify(merged.plan) : null,
          this.now(),
          id,
        )
      if (input.subtasks) this.replaceSubtasks(id, input.subtasks)
      return this.require(id)
    })
  }

  private replaceSubtasks(
    taskId: string,
    subtasks: { description: string; phase?: string | null }[],
  ) {
    if (subtasks.length === 0) return
    const done = new Map(
      (
        this.db
          .prepare("SELECT ref FROM subtasks WHERE task_id = ? AND status = 'completed'")
          .all(taskId) as { ref: string }[]
      ).map((row) => [row.ref, true]),
    )
    this.db.prepare('DELETE FROM subtasks WHERE task_id = ?').run(taskId)
    const insert = this.db.prepare(
      'INSERT INTO subtasks (task_id, ref, phase, description, status, position) VALUES (?, ?, ?, ?, ?, ?)',
    )
    subtasks.forEach((subtask, index) => {
      const ref = `1.${index + 1}`
      insert.run(
        taskId,
        ref,
        subtask.phase ?? null,
        subtask.description,
        done.has(ref) ? 'completed' : 'pending',
        index,
      )
    })
  }

  list(filter: ListFilter = {}): Task[] {
    const where: string[] = []
    const args: (string | number)[] = []
    const add = (clause: string, value: string | number | undefined) => {
      if (value === undefined) return
      where.push(clause)
      args.push(value)
    }
    add('project_id = ?', filter.project_id)
    add('status = ?', filter.status)
    add('task_type = ?', filter.task_type)
    add('priority = ?', filter.priority)
    const rows = this.db
      .prepare(
        `SELECT * FROM tasks ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
         ORDER BY priority, created_at DESC`,
      )
      .all(...args) as Row[]
    let tasks = rows.map(toTask)
    if (filter.labels?.length)
      tasks = tasks.filter((task) => filter.labels?.every((label) => task.labels.includes(label)))
    return tasks.slice(0, filter.limit ?? 50)
  }

  subtasks(taskId: string): Subtask[] {
    return this.db
      .prepare('SELECT * FROM subtasks WHERE task_id = ? ORDER BY position')
      .all(taskId) as unknown as Subtask[]
  }

  blockers(taskId: string): { id: string; status: string }[] {
    return this.db
      .prepare(
        `SELECT t.id AS id, t.status AS status FROM task_blockers b
         JOIN tasks t ON t.id = b.blocked_by WHERE b.task_id = ? ORDER BY t.id`,
      )
      .all(taskId) as { id: string; status: string }[]
  }

  log(taskId: string): { at: number; message: string }[] {
    return this.db
      .prepare('SELECT at, message FROM task_log WHERE task_id = ? ORDER BY id')
      .all(taskId) as { at: number; message: string }[]
  }

  appendLog(taskId: string, message: string): void {
    this.require(taskId)
    if (!message.trim()) throw new TaskError('a log entry needs a message')
    this.db
      .prepare('INSERT INTO task_log (task_id, at, message) VALUES (?, ?, ?)')
      .run(taskId, this.now(), message.trim())
    this.db.prepare('UPDATE tasks SET updated_at = ? WHERE id = ?').run(this.now(), taskId)
  }

  // -- claims --------------------------------------------------------------------------------

  /** The open claim on a task (subtask '') or one of its subtasks. */
  openClaim(taskId: string, subtask = ''): Claim | null {
    return (
      (this.db
        .prepare('SELECT * FROM claims WHERE task_id = ? AND subtask = ? AND released_at IS NULL')
        .get(taskId, subtask) as unknown as Claim | undefined) ?? null
    )
  }

  /** Every claim ever made on the task, oldest first: released ones stay as history. */
  claims(taskId: string): Claim[] {
    return this.db
      .prepare('SELECT * FROM claims WHERE task_id = ? ORDER BY id')
      .all(taskId) as unknown as Claim[]
  }

  /**
   * Claim a task, or with `ref` one subtask (which claims the task for the caller first when it
   * is free). The same caller claiming again resumes. Another caller's claim is refused unless
   * `force`, which takes it over and keeps the old row as history.
   */
  claim(
    taskId: string,
    caller: Caller,
    options: { ref?: string; force?: boolean } = {},
  ): 'claimed' | 'resumed' {
    return transaction(this.db, () => {
      const task = this.require(taskId)
      const ref = options.ref ?? ''
      if (ref) this.requireSubtask(taskId, ref)
      if (task.status === 'completed' || task.status === 'abandoned')
        throw new TaskError(`task ${taskId} is ${task.status}; it cannot be claimed`)
      const open = this.blockers(taskId).filter((blocker) => blocker.status !== 'completed')
      if (open.length)
        throw new TaskError(`task ${taskId} is blocked by ${open.map((b) => b.id).join(', ')}`)
      const force = options.force === true
      const taskResult = this.takeClaim(taskId, '', caller, force)
      let result = taskResult
      if (ref) {
        result = this.takeClaim(taskId, ref, caller, force)
        this.db
          .prepare(
            "UPDATE subtasks SET status = 'running' WHERE task_id = ? AND ref = ? AND status = 'pending'",
          )
          .run(taskId, ref)
      }
      this.link(taskId, caller)
      return result
    })
  }

  /** The caller's open claim on `subtask` ('' is the task), made when there is none. */
  private takeClaim(
    taskId: string,
    subtask: string,
    caller: Caller,
    force: boolean,
  ): 'claimed' | 'resumed' {
    const open = this.openClaim(taskId, subtask)
    if (open?.owner === caller.owner) return 'resumed'
    if (open) {
      if (!force)
        throw new TaskError(
          `${subtask ? `subtask ${subtask} of ` : ''}task ${taskId} is claimed by ${open.owner} since ${new Date(open.claimed_at).toISOString()}; --force takes over a stale claim`,
        )
      this.release1(open, `taken over by ${caller.owner}`)
    }
    if (!subtask) {
      const status = this.require(taskId).status
      if (!CLAIMABLE.includes(status) && status !== 'running')
        throw new TaskError(`task ${taskId} is ${status}; it cannot be claimed`)
      this.setStatus(taskId, 'running')
      this.db
        .prepare('UPDATE tasks SET started_at = COALESCE(started_at, ?) WHERE id = ?')
        .run(this.now(), taskId)
    }
    this.db
      .prepare(
        'INSERT INTO claims (task_id, subtask, owner, session_id, claimed_at) VALUES (?, ?, ?, ?, ?)',
      )
      .run(taskId, subtask, caller.owner, caller.session?.id ?? null, this.now())
    this.appendLog(taskId, `${caller.owner} claimed ${subtask ? `subtask ${subtask}` : 'the task'}`)
    return 'claimed'
  }

  private release1(claim: Claim, reason: string): void {
    this.db
      .prepare('UPDATE claims SET released_at = ?, release_reason = ? WHERE id = ?')
      .run(this.now(), reason, claim.id)
  }

  /**
   * Give a claim back. A task goes to pending (or paused) and its subtasks' claims are released
   * with it; a subtask goes back to pending.
   */
  release(
    taskId: string,
    caller: Caller,
    options: { ref?: string; pause?: boolean; force?: boolean } = {},
  ): void {
    transaction(this.db, () => {
      this.require(taskId)
      const open = this.openClaim(taskId, options.ref ?? '')
      if (!open)
        throw new TaskError(
          `${options.ref ? `subtask ${options.ref} of ` : ''}task ${taskId} has no open claim`,
        )
      if (open.owner !== caller.owner && !options.force)
        throw new TaskError(`it is claimed by ${open.owner}; --force releases another's claim`)
      this.release1(open, options.pause ? 'paused' : 'released')
      if (options.ref) {
        this.db
          .prepare(
            "UPDATE subtasks SET status = 'pending' WHERE task_id = ? AND ref = ? AND status = 'running'",
          )
          .run(taskId, options.ref)
        return
      }
      this.releaseSubtaskClaims(taskId, options.pause ? 'paused' : 'released')
      this.setStatus(taskId, options.pause ? 'paused' : 'pending')
      this.appendLog(taskId, `${caller.owner} ${options.pause ? 'paused' : 'released'} the task`)
    })
  }

  private releaseSubtaskClaims(taskId: string, reason: string): void {
    this.db
      .prepare(
        "UPDATE claims SET released_at = ?, release_reason = ? WHERE task_id = ? AND subtask != '' AND released_at IS NULL",
      )
      .run(this.now(), reason, taskId)
    this.db
      .prepare("UPDATE subtasks SET status = 'pending' WHERE task_id = ? AND status = 'running'")
      .run(taskId)
  }

  // -- finishing -----------------------------------------------------------------------------

  /**
   * Record that a task (or subtask) is done: the summary and the outcome only. Another caller's
   * claim is refused unless `force`. A finished task or subtask is a no-op (returns false).
   */
  done(
    taskId: string,
    caller: Caller,
    options: {
      ref?: string
      summary?: string
      outcome?: 'completed' | 'failed'
      force?: boolean
    } = {},
  ): boolean {
    return transaction(this.db, () => {
      const task = this.require(taskId)
      const outcome = options.outcome ?? 'completed'
      const claim = this.openClaim(taskId, options.ref ?? '')
      if (claim && claim.owner !== caller.owner && !options.force)
        throw new TaskError(`it is claimed by ${claim.owner}; --force closes it anyway`)
      if (options.ref) {
        const subtask = this.requireSubtask(taskId, options.ref)
        if (subtask.status === 'completed') return false
        if (claim) this.release1(claim, 'done')
        this.db
          .prepare(
            "UPDATE subtasks SET status = 'completed', summary = ?, completed_at = ? WHERE task_id = ? AND ref = ?",
          )
          .run(options.summary ?? null, this.now(), taskId, options.ref)
        this.appendLog(
          taskId,
          `subtask ${options.ref} done${options.summary ? `: ${options.summary}` : ''}`,
        )
        return true
      }
      if (task.status === 'completed') return false
      if (task.status === 'abandoned') throw new TaskError(`task ${taskId} was abandoned`)
      if (outcome === 'completed') {
        const open = this.subtasks(taskId).filter((subtask) => subtask.status !== 'completed')
        if (open.length)
          throw new TaskError(
            `task ${taskId} still has open subtasks: ${open.map((s) => s.ref).join(', ')}`,
          )
      }
      if (claim) this.release1(claim, 'done')
      this.releaseSubtaskClaims(taskId, 'done')
      this.db
        .prepare(
          'UPDATE tasks SET status = ?, summary = ?, outcome = ?, completed_at = ?, updated_at = ? WHERE id = ?',
        )
        .run(outcome, options.summary ?? null, outcome, this.now(), this.now(), taskId)
      this.appendLog(taskId, `${outcome}${options.summary ? `: ${options.summary}` : ''}`)
      return true
    })
  }

  /** What `abandon TASK` asks to be repeated with, so a stale preview cannot confirm. */
  abandonToken(taskId: string): string {
    const task = this.require(taskId)
    return shortDigest(`${task.id}:${task.status}:${task.updated_at}`)
  }

  /** Abandon a task (closed, history kept) or reset one subtask to pending. */
  abandon(taskId: string, options: { ref?: string; reason?: string } = {}): void {
    transaction(this.db, () => {
      const task = this.require(taskId)
      if (options.ref) {
        this.requireSubtask(taskId, options.ref)
        const claim = this.openClaim(taskId, options.ref)
        if (claim) this.release1(claim, 'abandoned')
        this.db
          .prepare(
            "UPDATE subtasks SET status = 'pending', summary = NULL, completed_at = NULL WHERE task_id = ? AND ref = ?",
          )
          .run(taskId, options.ref)
        this.appendLog(
          taskId,
          `subtask ${options.ref} reset${options.reason ? `: ${options.reason}` : ''}`,
        )
        return
      }
      if (task.status === 'completed') throw new TaskError(`task ${taskId} is completed`)
      for (const claim of this.claims(taskId))
        if (claim.released_at === null) this.release1(claim, 'abandoned')
      this.db
        .prepare("UPDATE tasks SET status = 'abandoned', summary = ?, updated_at = ? WHERE id = ?")
        .run(options.reason ?? null, this.now(), taskId)
      this.appendLog(taskId, `abandoned${options.reason ? `: ${options.reason}` : ''}`)
    })
  }

  // -- sessions ------------------------------------------------------------------------------

  /** Link the caller's session to the task (many to many); a task claimed outside a session links nothing. */
  link(taskId: string, caller: Caller): void {
    if (!caller.session) return
    this.db
      .prepare(
        `INSERT OR IGNORE INTO task_sessions (task_id, session_id, tether_session, linked_at)
         VALUES (?, ?, ?, ?)`,
      )
      .run(taskId, caller.session.id, caller.session.tether ?? null, this.now())
  }

  sessions(taskId: string): SessionLink[] {
    return this.db
      .prepare('SELECT * FROM task_sessions WHERE task_id = ? ORDER BY linked_at, session_id')
      .all(taskId) as unknown as SessionLink[]
  }

  tasksOfSession(sessionId: string): string[] {
    return (
      this.db
        .prepare('SELECT task_id FROM task_sessions WHERE session_id = ? ORDER BY linked_at')
        .all(sessionId) as { task_id: string }[]
    ).map((row) => row.task_id)
  }

  // -- helpers -------------------------------------------------------------------------------

  private requireSubtask(taskId: string, ref: string): Subtask {
    const row = this.db
      .prepare('SELECT * FROM subtasks WHERE task_id = ? AND ref = ?')
      .get(taskId, ref) as unknown as Subtask | undefined
    if (!row) throw new TaskError(`subtask ${ref} not found in task ${taskId}`)
    return row
  }

  private setStatus(taskId: string, status: TaskStatus): void {
    this.db
      .prepare('UPDATE tasks SET status = ?, updated_at = ? WHERE id = ?')
      .run(status, this.now(), taskId)
  }
}

function shortDigest(text: string): string {
  // A short fixed digest: stable for the same state, different once the task changes.
  let hash = 5381
  for (const char of text) hash = (Math.imul(hash, 33) ^ char.charCodeAt(0)) >>> 0
  return hash.toString(36).padStart(7, '0')
}
