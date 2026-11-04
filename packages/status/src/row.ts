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

export const ACTION_KINDS = ['run', 'log', 'detail', 'look'] as const
export type ActionKind = (typeof ACTION_KINDS)[number]

export interface Action {
  kind: ActionKind
  ref: string
}

export interface StatusRow {
  id: string
  what: string
  kind: Kind
  machine: string
  project?: string
  state: State
  meaning: string
  /** RFC 3339, normalized to UTC (`toISOString`). */
  last_run?: string
  /** When the next report is due, normalized like last_run. */
  next_run?: string
  actions?: Action[]
}

export const LIMITS = {
  id: { pattern: /^[A-Za-z0-9][A-Za-z0-9._:/@-]*$/, max: 200 },
  what: { max: 120 },
  machine: { pattern: /^[A-Za-z0-9][A-Za-z0-9._-]*$/, max: 100 },
  project: { pattern: /^[a-z0-9][a-z0-9_-]*$/, max: 100 },
  meaning: { max: 300 },
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
  'actions',
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

const RFC3339 = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(\.\d+)?(Z|[+-]\d{2}:\d{2})$/

/** An RFC 3339 date-time with a zone, as epoch ms; null when it is not one or names an impossible date. */
export function parseTime(value: string): number | null {
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
  if (value.length > check.max)
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
    const extra = Object.keys(action).find((key) => key !== 'kind' && key !== 'ref')
    if (extra) throw new RowError('actions', `an action has no field ${extra}`)
    if (
      typeof action.kind !== 'string' ||
      !(ACTION_KINDS as readonly string[]).includes(action.kind)
    )
      throw new RowError('actions', `an action's kind must be one of ${ACTION_KINDS.join(', ')}`)
    const ref = action.ref
    if (typeof ref !== 'string' || ref.length === 0 || ref.length > LIMITS.actions.ref)
      throw new RowError('actions', `an action's ref is 1 to ${LIMITS.actions.ref} characters`)
    return { kind: action.kind as ActionKind, ref }
  })
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
  const list = actions(body.actions)
  if (list !== undefined) row.actions = list
  return row
}
