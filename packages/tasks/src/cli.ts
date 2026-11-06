// `aico tasks ...` and `aico projects ...`. Output and options follow the `st` verbs agents use
// today (create, list, claim, context, log, done, abandon) so the alias swap is mechanical.

import { existsSync, readFileSync } from 'node:fs'
import { type ParseArgsOptionsConfig, parseArgs } from 'node:util'
import { type Database, openTasksDb } from './db'
import { contextLines, createdLine, subtaskLine, taskLine, time } from './format'
import { callerFromEnv } from './identity'
import { ProjectError, Registry } from './projects'
import { isSubtaskRef, type NewTask, type Task, TaskError, TaskStore } from './tasks'

export interface Io {
  out(line: string): void
  err(line: string): void
}

export interface Deps {
  db: Database
  now?: () => number
  cwd: string
  env: NodeJS.ProcessEnv
  /** One line about a linked session from the session history, or null when unknown. */
  describeSession?: (id: string) => Promise<string | null>
}

class UsageError extends Error {}

const TASKS_USAGE = `Usage: aico tasks <command> [options]
  create [TITLE]    create a pending task (-d, -p, -l, -t, --parent, --plan, --task, --blocked-by, --from-file, --dry-run)
  list              tasks of the project (cwd or -P), by priority then newest (-s -t -p -l --limit --json)
  show ID           one task: details, subtasks, claims, linked sessions, log
  context ID        task or subtask context in a few lines (-s SUBTASK)
  claim ID          claim a task, or a subtask with -t TASK (--force takes over a stale claim)
  release ID        give a claim back (--pause marks the task paused)
  log ID MESSAGE    append a progress note
  done ID           record the summary and outcome (-m, --outcome completed|failed)
  abandon ID        abandon a task (preview, then --confirm TOKEN) or reset a subtask
Project: -P ID, else the project whose folder holds the current directory, else AICO_PROJECT_ID.`

const PROJECTS_USAGE = `Usage: aico projects <command>
  list [--all]                         registered projects (--all includes retired ones)
  show ID                              one project, its settings and lifecycle events
  register ID --root PATH [--name N] [--category C]
  retire ID --reason TEXT              the project leaves lists; its tasks and history stay`

const ID_HELP = 'ID is a task id, or a subtask like 1.2 with --task PARENT.'

function opts<const T extends ParseArgsOptionsConfig>(argv: string[], options: T) {
  try {
    return parseArgs({ args: argv, options, allowPositionals: true, strict: true })
  } catch (error) {
    throw new UsageError((error as Error).message)
  }
}

function resolveProject(deps: Deps, explicit: string | undefined, registry: Registry): string {
  if (explicit) {
    if (!registry.get(explicit)) throw new TaskError(`no project ${explicit}`)
    return explicit
  }
  const here = registry.forCwd(deps.cwd)
  if (here) return here.id
  const fromEnv = deps.env.AICO_PROJECT_ID?.trim()
  if (fromEnv && registry.get(fromEnv)) return fromEnv
  throw new TaskError('no project here; use -P PROJECT (aico projects list)')
}

function fromPlan(plan: Record<string, unknown>): Partial<NewTask> {
  const subtasks = Array.isArray(plan.subtasks)
    ? (plan.subtasks as Record<string, unknown>[]).map((subtask) => ({
        description: String(subtask.description ?? subtask.title ?? ''),
        phase: typeof subtask.phase === 'string' ? subtask.phase : null,
      }))
    : []
  const rest = Object.fromEntries(
    Object.entries(plan).filter(
      ([key]) =>
        ![
          'title',
          'description',
          'task_type',
          'priority',
          'labels',
          'complexity',
          'done_when',
          'subtasks',
          '_meta',
        ].includes(key),
    ),
  )
  return {
    title: typeof plan.title === 'string' ? plan.title : undefined,
    description: typeof plan.description === 'string' ? plan.description : undefined,
    task_type: typeof plan.task_type === 'string' ? plan.task_type : undefined,
    priority: typeof plan.priority === 'number' ? plan.priority : undefined,
    labels: Array.isArray(plan.labels) ? plan.labels.map(String) : undefined,
    complexity: typeof plan.complexity === 'string' ? plan.complexity : undefined,
    acceptance: Array.isArray(plan.done_when) ? plan.done_when.map(String) : undefined,
    plan: Object.keys(rest).length ? rest : undefined,
    subtasks: subtasks.length ? subtasks : undefined,
  }
}

function readJson(path: string): Record<string, unknown> {
  if (!existsSync(path)) throw new UsageError(`${path} does not exist`)
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>
  } catch (error) {
    throw new UsageError(`${path} is not valid JSON: ${(error as Error).message}`)
  }
}

async function create(argv: string[], deps: Deps, io: Io): Promise<void> {
  const { values, positionals } = opts(argv, {
    description: { type: 'string', short: 'd' },
    priority: { type: 'string', short: 'p' },
    labels: { type: 'string', short: 'l' },
    type: { type: 'string', short: 't' },
    parent: { type: 'string' },
    plan: { type: 'string' },
    task: { type: 'string' },
    'blocked-by': { type: 'string' },
    'from-file': { type: 'string' },
    'dry-run': { type: 'boolean' },
    project: { type: 'string', short: 'P' },
  })
  const store = new TaskStore(deps.db, deps.now)
  const registry = new Registry(deps.db, deps.now)
  const priority = values.priority === undefined ? undefined : Number(values.priority)
  if (priority !== undefined && !(Number.isInteger(priority) && priority >= 0 && priority <= 4))
    throw new UsageError('--priority is 0 (highest) to 4')
  const base: Partial<NewTask> = {
    description: values.description,
    priority,
    labels: values.labels
      ?.split(',')
      .map((label) => label.trim())
      .filter(Boolean),
    task_type: values.type,
    parent_task_id: values.parent,
    blocked_by: values['blocked-by'],
  }
  const merge = (plan: Partial<NewTask>): Partial<NewTask> => {
    const out: Partial<NewTask> = { ...plan }
    for (const [key, value] of Object.entries(base))
      if (value !== undefined) {
        if (key === 'labels' && plan.labels) out.labels = [...plan.labels, ...(value as string[])]
        else (out as Record<string, unknown>)[key] = value
      }
    if (positionals[0]) out.title = positionals[0]
    return out
  }
  if (values['dry-run'] && !values.plan && !values['from-file'])
    throw new UsageError('--dry-run only works with --from-file or --plan')

  if (values['from-file']) {
    const file = readJson(values['from-file'])
    const items = Array.isArray(file.tasks) ? (file.tasks as Record<string, unknown>[]) : null
    if (!items) throw new UsageError(`${values['from-file']} needs a "tasks" array`)
    const project = resolveProject(deps, values.project, registry)
    for (const item of items) {
      const input = { ...fromPlan(item), project_id: project } as NewTask
      if (!input.title) throw new TaskError('every task in the file needs a title')
      if (values['dry-run'])
        io.out(`DRY-RUN:${input.title}|${input.subtasks?.length ?? 0} subtasks`)
      else {
        const task = store.create(input)
        io.out(`IMPORT:${task.id}|${task.complexity ?? 'SIMPLE'}|`)
      }
    }
    return
  }
  if (values.plan) {
    const plan = merge(fromPlan(readJson(values.plan)))
    if (values.task) {
      if (values['dry-run'])
        return io.out(`DRY-RUN:update ${values.task}|${plan.subtasks?.length ?? 0} subtasks`)
      const task = store.update(values.task, plan)
      return io.out(`IMPORT:${task.id}|${task.complexity ?? 'SIMPLE'}|updated`)
    }
    if (!plan.title) throw new UsageError('the plan needs a title (or pass TITLE)')
    if (values['dry-run'])
      return io.out(`DRY-RUN:${plan.title}|${plan.subtasks?.length ?? 0} subtasks`)
    const task = store.create({
      ...plan,
      project_id: resolveProject(deps, values.project, registry),
    } as NewTask)
    return io.out(`IMPORT:${task.id}|${task.complexity ?? 'SIMPLE'}|`)
  }
  const title = positionals[0]
  if (!title) throw new UsageError('a task needs a title: aico tasks create "title"')
  const task = store.create({
    ...(merge({}) as NewTask),
    title,
    project_id: resolveProject(deps, values.project, registry),
  })
  io.out(createdLine(task, store.subtasks(task.id)))
}

async function list(argv: string[], deps: Deps, io: Io): Promise<void> {
  const { values } = opts(argv, {
    status: { type: 'string', short: 's' },
    type: { type: 'string', short: 't' },
    priority: { type: 'string', short: 'p' },
    labels: { type: 'string', short: 'l' },
    limit: { type: 'string' },
    json: { type: 'boolean' },
    compact: { type: 'boolean' },
    'no-compact': { type: 'boolean' },
    project: { type: 'string', short: 'P' },
  })
  const registry = new Registry(deps.db, deps.now)
  const tasks = new TaskStore(deps.db, deps.now).list({
    project_id: resolveProject(deps, values.project, registry),
    status: values.status,
    task_type: values.type,
    priority: values.priority === undefined ? undefined : Number(values.priority),
    labels: values.labels?.split(',').map((label) => label.trim()),
    limit: values.limit === undefined ? undefined : Number(values.limit),
  })
  if (values.json) return io.out(JSON.stringify({ tasks, total: tasks.length }))
  io.out(`TASKS[${tasks.length}]`)
  for (const task of tasks) io.out(taskLine(task))
}

async function sessionLines(store: TaskStore, task: Task, deps: Deps): Promise<string[]> {
  const lines: string[] = []
  for (const link of store.sessions(task.id)) {
    const known = await deps.describeSession?.(link.session_id).catch(() => null)
    const via =
      link.tether_session && link.tether_session !== link.session_id
        ? ` (Tether ${link.tether_session})`
        : ''
    lines.push(
      `  ${link.session_id}${via}${known ? `  ${known}` : ''}  linked ${time(link.linked_at)}`,
    )
  }
  return lines
}

async function show(argv: string[], deps: Deps, io: Io): Promise<void> {
  const { values, positionals } = opts(argv, { json: { type: 'boolean' } })
  const id = positionals[0]
  if (!id) throw new UsageError('aico tasks show ID')
  const store = new TaskStore(deps.db, deps.now)
  const task = store.require(id)
  const subtasks = store.subtasks(id)
  const claims = store.claims(id)
  const log = store.log(id)
  const sessions = store.sessions(id)
  if (values.json) return io.out(JSON.stringify({ task, subtasks, claims, sessions, log }))
  io.out(taskLine(task))
  io.out(
    `id ${task.id}  project ${task.project_id}  created ${time(task.created_at)}  updated ${time(task.updated_at)}`,
  )
  if (task.description) io.out(task.description)
  if (task.acceptance.length) io.out(`Done when: ${task.acceptance.join(' | ')}`)
  if (task.summary) io.out(`${task.outcome ?? 'Summary'}: ${task.summary}`)
  if (subtasks.length) {
    io.out(`Subtasks (${subtasks.length}):`)
    for (const subtask of subtasks) io.out(`  ${subtaskLine(subtask)}`)
  }
  io.out(`Claims (${claims.length}):`)
  for (const claim of claims)
    io.out(
      `  ${claim.subtask || 'task'}  ${claim.owner}  ${time(claim.claimed_at)}${claim.released_at === null ? '  open' : `  released ${time(claim.released_at)} (${claim.release_reason})`}`,
    )
  io.out(`Sessions (${sessions.length}):`)
  for (const line of await sessionLines(store, task, deps)) io.out(line)
  io.out(`Log (${log.length}):`)
  for (const entry of log.slice(-10)) io.out(`  ${time(entry.at)}  ${entry.message}`)
}

async function context(argv: string[], deps: Deps, io: Io): Promise<void> {
  const { values, positionals } = opts(argv, {
    subtask: { type: 'string', short: 's' },
    compact: { type: 'boolean' },
    'no-compact': { type: 'boolean' },
  })
  const id = positionals[0]
  if (!id) throw new UsageError('aico tasks context TASK_ID [-s SUBTASK]')
  const store = new TaskStore(deps.db, deps.now)
  const task = store.require(id)
  const subtasks = store.subtasks(id)
  if (values.subtask) {
    const subtask = subtasks.find((candidate) => candidate.ref === values.subtask)
    if (!subtask) throw new TaskError(`Subtask ${values.subtask} not found in task ${id}`)
    io.out(
      `SUBTASK:${task.id}|${subtask.ref}|${subtask.status}|${subtask.phase ?? 'implementation'}`,
    )
    io.out(`DESCRIPTION:${subtask.description}`)
    const claim = store.openClaim(id, subtask.ref)
    io.out(`CLAIM:${claim ? `${claim.owner} since ${time(claim.claimed_at)}` : 'none'}`)
    return
  }
  for (const line of contextLines({
    task,
    subtasks,
    claim: store.openClaim(id),
    blockers: store.blockers(id),
    recent: store.log(id).slice(-3),
    sessions: store.sessions(id),
  }))
    io.out(line)
}

/** The task id and subtask ref `claim`, `done`, `abandon` and `release` mean by ID and --task. */
function target(
  id: string | undefined,
  task: string | undefined,
): { taskId: string; ref?: string } {
  if (!id) throw new UsageError(`an ID is needed. ${ID_HELP}`)
  if (isSubtaskRef(id)) {
    if (!task) throw new UsageError(`subtask ${id} needs --task PARENT. ${ID_HELP}`)
    return { taskId: task, ref: id }
  }
  return { taskId: id }
}

async function claim(argv: string[], deps: Deps, io: Io): Promise<void> {
  const { values, positionals } = opts(argv, {
    task: { type: 'string', short: 't' },
    force: { type: 'boolean', short: 'f' },
  })
  const { taskId, ref } = target(positionals[0], values.task)
  const store = new TaskStore(deps.db, deps.now)
  const result = store.claim(taskId, callerFromEnv(deps.env), { ref, force: values.force })
  const what = ref ? `Subtask ${ref}` : `Task ${taskId}`
  io.out(`PASS ${what} ${result === 'resumed' ? 'resumed.' : 'claimed.'}`)
  const task = store.require(taskId)
  io.out(`Task: ${task.title}`)
  if (task.description) io.out(task.description)
  if (task.acceptance.length) io.out(`Done when: ${task.acceptance.join(' | ')}`)
  io.out(
    `Next: aico tasks done ${ref ?? taskId}${ref ? ` -t ${taskId}` : ''} when finished; aico tasks context ${taskId} has the details.`,
  )
}

async function release(argv: string[], deps: Deps, io: Io): Promise<void> {
  const { values, positionals } = opts(argv, {
    task: { type: 'string', short: 't' },
    pause: { type: 'boolean' },
    force: { type: 'boolean', short: 'f' },
  })
  const { taskId, ref } = target(positionals[0], values.task)
  new TaskStore(deps.db, deps.now).release(taskId, callerFromEnv(deps.env), {
    ref,
    pause: values.pause,
    force: values.force,
  })
  io.out(
    `PASS ${ref ? `Subtask ${ref}` : `Task ${taskId}`} ${values.pause ? 'paused.' : 'released.'}`,
  )
}

async function log(argv: string[], deps: Deps, io: Io): Promise<void> {
  const { values, positionals } = opts(argv, {
    task: { type: 'string', short: 't' },
    message: { type: 'string', short: 'm' },
  })
  // `log TASK_ID "message"`, or `log "message" -t TASK_ID`, or -m.
  let taskId = values.task
  let message = values.message
  const [first, second] = positionals
  if (!taskId && first?.startsWith('task-')) {
    taskId = first
    message ??= second
  } else {
    message ??= first
    taskId ??= second
  }
  if (!taskId || !message) throw new UsageError('aico tasks log TASK_ID "message"')
  const store = new TaskStore(deps.db, deps.now)
  const task = store.require(taskId)
  store.appendLog(taskId, message)
  io.out(
    JSON.stringify({
      status: 'appended',
      project_id: task.project_id,
      task_id: taskId,
      entry: message.trim(),
    }),
  )
}

/** st done's options that the checks (M10b) will act on; accepted now so the verb matches. */
const LATER_DONE_FLAGS = [
  'paths',
  'path',
  'record-only',
  'none',
  'citation',
  'evidence',
  'budget-note',
  'with-ack',
  'paths-from-range',
] as const

async function done(argv: string[], deps: Deps, io: Io): Promise<void> {
  const { values, positionals } = opts(argv, {
    task: { type: 'string', short: 't' },
    message: { type: 'string', short: 'm' },
    outcome: { type: 'string' },
    force: { type: 'boolean', short: 'f' },
    path: { type: 'string', multiple: true },
    paths: { type: 'string', multiple: true },
    'record-only': { type: 'boolean' },
    none: { type: 'boolean' },
    citation: { type: 'string', multiple: true },
    evidence: { type: 'string' },
    'budget-note': { type: 'string' },
    'with-ack': { type: 'string' },
    'paths-from-range': { type: 'string' },
  })
  const given = LATER_DONE_FLAGS.filter((flag) => values[flag] !== undefined)
  if (given.length) io.err(`WARN not checked or recorded yet: --${given.join(', --')}`)
  if (values.outcome && values.outcome !== 'completed' && values.outcome !== 'failed')
    throw new UsageError('--outcome is completed or failed')
  const { taskId, ref } = target(positionals[0], values.task)
  const changed = new TaskStore(deps.db, deps.now).done(taskId, callerFromEnv(deps.env), {
    ref,
    summary: values.message,
    outcome: values.outcome as 'completed' | 'failed' | undefined,
    force: values.force,
  })
  const what = ref ? `Subtask ${ref}` : `Task ${taskId}`
  io.out(
    changed
      ? `PASS ${what} ${values.outcome === 'failed' ? 'recorded as failed.' : 'completed.'}`
      : `PASS ${what} was already completed.`,
  )
}

async function abandon(argv: string[], deps: Deps, io: Io): Promise<void> {
  const { values, positionals } = opts(argv, {
    task: { type: 'string', short: 't' },
    confirm: { type: 'string' },
    reason: { type: 'string', short: 'r' },
  })
  const { taskId, ref } = target(positionals[0], values.task)
  const store = new TaskStore(deps.db, deps.now)
  if (ref) {
    store.abandon(taskId, { ref, reason: values.reason })
    return io.out(`PASS Subtask ${ref} reset to pending.`)
  }
  const token = store.abandonToken(taskId)
  if (values.confirm !== token) {
    io.out(
      `Abandoning ${taskId} closes it as abandoned and releases its claims. Rerun with --confirm ${token}`,
    )
    return
  }
  store.abandon(taskId, { reason: values.reason })
  io.out(`PASS Task ${taskId} abandoned.`)
}

export async function runTasks(argv: string[], deps: Deps, io: Io): Promise<number> {
  const [command, ...rest] = argv
  if (!command || command === '--help' || command === '-h' || command === 'help') {
    io.out(TASKS_USAGE)
    return command ? 0 : 2
  }
  const commands: Record<string, (a: string[], d: Deps, i: Io) => Promise<void>> = {
    create,
    list,
    show,
    context,
    claim,
    release,
    log,
    done,
    abandon,
  }
  const run = commands[command]
  if (!run) {
    io.err(`aico tasks: unknown command '${command}'`)
    io.err(TASKS_USAGE)
    return 2
  }
  if (rest.includes('--help') || rest.includes('-h')) {
    io.out(`${TASKS_USAGE}\n${ID_HELP}`)
    return 0
  }
  try {
    await run(rest, deps, io)
    return 0
  } catch (error) {
    if (error instanceof UsageError) {
      io.err(`ERROR ${error.message}`)
      return 2
    }
    if (error instanceof TaskError || error instanceof ProjectError) {
      io.err(`ERROR ${error.message}`)
      return 1
    }
    throw error
  }
}

function projectJson(registry: Registry, id: string) {
  const project = registry.get(id)
  if (!project) throw new ProjectError(`no project ${id}`)
  return { ...project, lifecycle: project.retired_at === null ? 'active' : 'retired' }
}

export async function runProjects(argv: string[], deps: Deps, io: Io): Promise<number> {
  const [command, ...rest] = argv
  if (!command || command === '--help' || command === '-h' || command === 'help') {
    io.out(PROJECTS_USAGE)
    return command ? 0 : 2
  }
  const registry = new Registry(deps.db, deps.now)
  try {
    if (command === 'list') {
      const { values } = opts(rest, { all: { type: 'boolean' } })
      const current = registry.forCwd(deps.cwd)?.id ?? deps.env.AICO_PROJECT_ID
      io.out(
        JSON.stringify(
          registry.list({ all: values.all }).map((p) => ({
            id: p.id,
            name: p.name,
            root_path: p.root_path,
            current: p.id === current,
          })),
        ),
      )
    } else if (command === 'show' || command === 'get') {
      const id = rest[0]
      if (!id) throw new UsageError('aico projects show ID')
      io.out(JSON.stringify({ ...projectJson(registry, id), events: registry.events(id) }, null, 2))
    } else if (command === 'register') {
      const { values, positionals } = opts(rest, {
        root: { type: 'string' },
        name: { type: 'string' },
        category: { type: 'string' },
      })
      if (!positionals[0] || !values.root)
        throw new UsageError('aico projects register ID --root PATH [--name N]')
      registry.register({
        id: positionals[0],
        root: values.root,
        name: values.name,
        category: values.category,
      })
      io.out(`PASS Project ${positionals[0]} registered.`)
    } else if (command === 'retire') {
      const { values, positionals } = opts(rest, { reason: { type: 'string', short: 'r' } })
      if (!positionals[0]) throw new UsageError('aico projects retire ID --reason TEXT')
      registry.retire(positionals[0], values.reason ?? '')
      io.out(`PASS Project ${positionals[0]} retired.`)
    } else {
      io.err(`aico projects: unknown command '${command}'`)
      io.err(PROJECTS_USAGE)
      return 2
    }
    return 0
  } catch (error) {
    if (error instanceof UsageError) {
      io.err(`ERROR ${error.message}`)
      return 2
    }
    if (error instanceof ProjectError || error instanceof TaskError) {
      io.err(`ERROR ${error.message}`)
      return 1
    }
    throw error
  }
}

export { openTasksDb }
