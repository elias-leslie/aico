// The Status row a writer posts (contracts/status-row.schema.json), checked
// field by field. The schema is the contract; row.test.ts holds these lists and
// limits to it and replays contracts/status-row-fixtures.json.

export const KINDS = [
  'check',
  'job',
  'backup',
  'service',
  'vm',
  'machine',
  'link',
  'grant',
  'repo',
] as const
export type Kind = (typeof KINDS)[number]

/** What a writer reports. */
export const STATES = ['ok', 'warn', 'failed', 'off'] as const
export type State = (typeof STATES)[number]

export const ACTION_KINDS = ['run', 'log', 'detail', 'look', 'session'] as const
export type ActionKind = (typeof ACTION_KINDS)[number]

export interface Action {
  kind: ActionKind
  ref: string
  /** A failed row asks the owner only for an explicitly owner-only action. */
  owner_only?: boolean
}

export const GUARD_PHASES = ['hot', 'critical', 'recovered', 'unavailable'] as const

/** Native backup guard event; enforcement stays on the host when Aico is unavailable. */
export interface ThermalGuard {
  episode_id: string
  phase: (typeof GUARD_PHASES)[number]
  temperature_c: number | null
  cpu_quota_percent: number
  admission_open: boolean
  /** One Aico machine id is responsible for delivery across the fleet. */
  delivery_machine: string
}

export interface StatusRow {
  id: string
  what: string
  kind: Kind
  /** The host's short name in lower case (`machineId()`), the same on every row from it. */
  machine: string
  project?: string
  state: State
  meaning: string
  /** RFC 3339, normalized to UTC (`toISOString`). */
  last_run?: string
  /** When the next report is due, normalized like last_run; required for kind machine. */
  next_run?: string
  /** The job row whose run writes this one: not late while that job is paused or hasn't had its turn. */
  run_by?: string
  /** The exact scheduler execution, shared with the owning job's completed report. */
  run_id?: string
  actions?: Action[]
  guard?: ThermalGuard
}

export const LIMITS = {
  id: { pattern: /^[A-Za-z0-9][A-Za-z0-9._:/@-]*$/, max: 200 },
  what: { max: 120 },
  machine: { pattern: /^[a-z0-9][a-z0-9._-]*$/, max: 100 },
  project: { pattern: /^[a-z0-9][a-z0-9_-]*$/, max: 100 },
  meaning: { max: 800 },
  actions: { max: 4, ref: 500 },
} as const

const FIELDS = new Set([
  'id',
  'what',
  'kind',
  'machine',
  'project',
  'state',
  'meaning',
  'last_run',
  'next_run',
  'run_by',
  'run_id',
  'actions',
  'guard',
])

/** A row the contract refuses; `field` names the first offending field (`row` for the whole value). */
export class RowError extends Error {
  constructor(
    readonly field: string,
    message: string,
  ) {
    super(message)
  }
}

/** Length in code points, as the schema's maxLength and Python's len count it. */
const length = (value: string) => [...value].length

const RFC3339 = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(\.\d+)?(Z|[+-]\d{2}:\d{2})$/

/** An RFC 3339 date-time with a zone, as epoch ms; null when it is not one or names an impossible date. */
function parseTime(value: string): number | null {
  const match = RFC3339.exec(value)
  if (!match) return null
  const [year, month, day, hour, minute, second] = match.slice(1, 7).map(Number) as number[]
  const daysInMonth = new Date(Date.UTC(year as number, month as number, 0)).getUTCDate()
  if (month < 1 || month > 12 || day < 1 || day > daysInMonth) return null
  if (hour > 23 || minute > 59 || second > 59) return null
  const ms = Date.parse(value)
  return Number.isNaN(ms) ? null : ms
}

function text(
  body: Record<string, unknown>,
  field: string,
  check: { max: number; pattern?: RegExp },
  required: boolean,
): string | undefined {
  const value = body[field]
  if (value === undefined) {
    if (required) throw new RowError(field, `${field} is required`)
    return undefined
  }
  if (typeof value !== 'string' || value.length === 0)
    throw new RowError(field, `${field} must be a non-empty string`)
  if (length(value) > check.max)
    throw new RowError(field, `${field} is longer than ${check.max} characters`)
  if (check.pattern && !check.pattern.test(value))
    throw new RowError(field, `${field} has characters it may not have`)
  return value
}

function oneOf<T extends string>(
  body: Record<string, unknown>,
  field: string,
  values: readonly T[],
): T {
  const value = body[field]
  if (typeof value !== 'string' || !(values as readonly string[]).includes(value))
    throw new RowError(field, `${field} must be one of ${values.join(', ')}`)
  return value as T
}

function time(body: Record<string, unknown>, field: string): string | undefined {
  const value = body[field]
  if (value === undefined) return undefined
  const ms = typeof value === 'string' ? parseTime(value) : null
  if (ms === null)
    throw new RowError(
      field,
      `${field} must be an RFC 3339 time with a zone, e.g. 2026-11-03T03:30:00Z`,
    )
  return new Date(ms).toISOString()
}

function actions(value: unknown): Action[] | undefined {
  if (value === undefined) return undefined
  if (!Array.isArray(value) || value.length > LIMITS.actions.max)
    throw new RowError('actions', `actions must be a list of at most ${LIMITS.actions.max}`)
  return value.map((item) => {
    if (!item || typeof item !== 'object' || Array.isArray(item))
      throw new RowError('actions', 'each action is an object with kind and ref')
    const action = item as Record<string, unknown>
    const extra = Object.keys(action).find((key) => !['kind', 'ref', 'owner_only'].includes(key))
    if (extra) throw new RowError('actions', `an action has no field ${extra}`)
    if (
      typeof action.kind !== 'string' ||
      !(ACTION_KINDS as readonly string[]).includes(action.kind)
    )
      throw new RowError('actions', `an action's kind must be one of ${ACTION_KINDS.join(', ')}`)
    const ref = action.ref
    if (typeof ref !== 'string' || ref.length === 0 || length(ref) > LIMITS.actions.ref)
      throw new RowError('actions', `an action's ref is 1 to ${LIMITS.actions.ref} characters`)
    if (action.owner_only !== undefined && typeof action.owner_only !== 'boolean')
      throw new RowError('actions', 'owner_only must be a boolean')
    return {
      kind: action.kind as ActionKind,
      ref,
      ...(action.owner_only !== undefined && { owner_only: action.owner_only as boolean }),
    }
  })
}

function guard(value: unknown): ThermalGuard {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new RowError('guard', 'guard must be an object')
  const body = value as Record<string, unknown>
  const fields = [
    'episode_id',
    'phase',
    'temperature_c',
    'cpu_quota_percent',
    'admission_open',
    'delivery_machine',
  ]
  if (
    Object.keys(body).some((key) => !fields.includes(key)) ||
    fields.some((key) => !Object.hasOwn(body, key))
  )
    throw new RowError('guard', 'guard needs exactly its declared fields')
  try {
    const episode_id = text(body, 'episode_id', LIMITS.id, true) as string
    const phase = oneOf(body, 'phase', GUARD_PHASES)
    const delivery_machine = text(body, 'delivery_machine', LIMITS.machine, true) as string
    const { temperature_c, cpu_quota_percent, admission_open } = body
    if (
      temperature_c !== null &&
      (typeof temperature_c !== 'number' || !Number.isFinite(temperature_c))
    )
      throw new RowError('guard', 'temperature_c must be null or a finite number')
    if (
      typeof cpu_quota_percent !== 'number' ||
      !Number.isFinite(cpu_quota_percent) ||
      cpu_quota_percent < 0
    )
      throw new RowError('guard', 'cpu_quota_percent must be a non-negative number')
    if (typeof admission_open !== 'boolean')
      throw new RowError('guard', 'admission_open must be a boolean')
    return { episode_id, phase, temperature_c, cpu_quota_percent, admission_open, delivery_machine }
  } catch (error) {
    if (error instanceof RowError) throw new RowError('guard', error.message)
    throw error
  }
}

/** The row in `value`, times normalized to UTC; throws RowError when the contract refuses it. */
export function parseRow(value: unknown): StatusRow {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new RowError('row', 'a row is a JSON object')
  const body = value as Record<string, unknown>
  const extra = Object.keys(body).find((key) => !FIELDS.has(key))
  if (extra) throw new RowError(extra, `a row has no field ${extra}`)
  const row: StatusRow = {
    id: text(body, 'id', LIMITS.id, true) as string,
    what: text(body, 'what', LIMITS.what, true) as string,
    kind: oneOf(body, 'kind', KINDS),
    machine: text(body, 'machine', LIMITS.machine, true) as string,
    state: oneOf(body, 'state', STATES),
    meaning: text(body, 'meaning', LIMITS.meaning, true) as string,
  }
  const project = text(body, 'project', LIMITS.project, false)
  if (project !== undefined) row.project = project
  const lastRun = time(body, 'last_run')
  if (lastRun !== undefined) row.last_run = lastRun
  const nextRun = time(body, 'next_run')
  if (nextRun !== undefined) row.next_run = nextRun
  else if (row.kind === 'machine')
    throw new RowError('next_run', 'a machine row needs next_run: the unknown rule reads it')
  const runBy = text(body, 'run_by', LIMITS.id, false)
  if (runBy !== undefined) {
    if (nextRun === undefined) throw new RowError('run_by', 'run_by needs next_run')
    row.run_by = runBy
  }
  const runId = text(body, 'run_id', LIMITS.id, false)
  if (runId !== undefined) row.run_id = runId
  const list = actions(body.actions)
  if (list !== undefined) row.actions = list
  if (body.guard !== undefined) {
    row.guard = guard(body.guard)
    if (row.kind !== 'check' || lastRun === undefined)
      throw new RowError('guard', 'a guard needs kind check and last_run')
  }
  return row
}

/**
 * What the scheduler hands a job it runs on its home machine, so the rows that job writes can say
 * when they are next due from the job's real schedule. A stand-in's run gets none: its rows would
 * go late the moment the home took the job back.
 */
export const jobEnv = (
  kind: string,
  nextRun: number,
  everyMin?: number,
  runId?: string,
): Record<string, string> => ({
  AICO_JOB_KIND: kind,
  AICO_JOB_NEXT_RUN: new Date(nextRun).toISOString(),
  ...(everyMin === undefined ? {} : { AICO_JOB_EVERY_MIN: String(everyMin) }),
  ...(runId === undefined ? {} : { AICO_JOB_RUN_ID: runId }),
})

/**
 * next_run and run_by for a row written by the job `kind`; nothing when this isn't that job's
 * scheduled run (run by hand, or a command another job started). An interval job repeats after it
 * completes, so its next report counts from now.
 */
export function jobSchedule(
  kind: string,
  env: NodeJS.ProcessEnv,
  now = Date.now(),
): Pick<StatusRow, 'next_run' | 'run_by' | 'run_id'> {
  if (env.AICO_JOB_KIND !== kind || !env.AICO_JOB_NEXT_RUN) return {}
  const next = parseTime(env.AICO_JOB_NEXT_RUN)
  if (next === null || !LIMITS.id.pattern.test(`jobs/${kind}`)) return {}
  const runId = env.AICO_JOB_RUN_ID
  if (runId !== undefined && (!LIMITS.id.pattern.test(runId) || runId.length > LIMITS.id.max))
    return {}
  const every = env.AICO_JOB_EVERY_MIN === undefined ? undefined : Number(env.AICO_JOB_EVERY_MIN)
  if (every !== undefined && (!Number.isFinite(every) || every <= 0)) return {}
  const due = every === undefined ? next : now + every * 60_000
  if (!Number.isFinite(due) || Math.abs(due) > 8.64e15) return {}
  return {
    next_run: new Date(due).toISOString(),
    run_by: `jobs/${kind}`,
    ...(runId === undefined ? {} : { run_id: runId }),
  }
}
