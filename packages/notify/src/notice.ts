// The notice a sender gives Aico (contracts/notice.schema.json), notice v1:
// senders and the OmniNull hub keep their JSON. The schema is the contract;
// contract.test.ts holds these lists and limits to it and replays
// contracts/notice-fixtures.json.

export const KINDS = ['alert', 'todo', 'question', 'info'] as const
export type NoticeKind = (typeof KINDS)[number]

export const SEVERITIES = ['critical', 'warning', 'info', 'ok'] as const
export type Severity = (typeof SEVERITIES)[number]

export const ACTIONS = [
  'expected',
  'not-expected',
  'mute',
  'look-into',
  'answer',
  'open',
  'done',
  'mark-read',
] as const
export type NoticeAction = (typeof ACTIONS)[number]

export const PUSH = ['phone', 'tray'] as const
export type Push = (typeof PUSH)[number]

export interface Field {
  label: string
  value: string
}

/** A notice as read: defaults filled in. */
export interface Notice {
  v: 1
  source: string
  kind: NoticeKind
  severity: Severity
  title: string
  body: string
  detail?: string
  key?: string
  open?: string
  command?: string
  fields: Field[]
  actions: NoticeAction[]
  /** One of `actions`, or '' when the sender named none. */
  primary: NoticeAction | ''
  push: Push
  /** Seconds a repeat of `key` stays quiet. */
  cooldown: number
  /** Seconds after sending when it ends by itself. */
  expires?: number
  if_ignored?: string
}

const DEFAULT_COOLDOWN_S = 3600
const WEEK_S = 7 * 86400

export const LIMITS = {
  source: { pattern: /^[a-z0-9][a-z0-9-]{0,39}$/ },
  title: { min: 1, max: 200 },
  body: { min: 1, max: 1000 },
  detail: { min: 0, max: 4000 },
  key: { pattern: /^[A-Za-z0-9][A-Za-z0-9_.:/@+=,-]{0,199}$/ },
  open: { pattern: /^https:\/\//, max: 300 },
  command: { min: 1, max: 300 },
  if_ignored: { min: 1, max: 300 },
  fields: { max: 8, label: 40, value: 300 },
  cooldown: { min: 0, max: WEEK_S },
  expires: { min: 60, max: WEEK_S },
} as const

const FIELDS = new Set([
  'v',
  'source',
  'kind',
  'severity',
  'title',
  'body',
  'detail',
  'key',
  'open',
  'command',
  'fields',
  'actions',
  'primary',
  'push',
  'cooldown',
  'expires',
  'if_ignored',
])

/** A template field nobody filled in ("old kernel {running}"); `{}` and JSON-like text pass. */
const UNFILLED = /\{[A-Za-z_][A-Za-z0-9_.]*(?:![rsa])?(?::[^{}]*)?\}/
/** An open link that is an Aico ask (`?ask=<id>`), which `answer` needs. */
const ASK_LINK = /[?&]ask=[0-9a-f]{12}\b/
const KEYED = ['expected', 'not-expected', 'mute'] as const

/** A notice the contract refuses; `field` names the first offending field (`notice` for the whole value). */
export class NoticeError extends Error {
  constructor(
    readonly field: string,
    message: string,
  ) {
    super(message)
  }
}

/** Length in code points, as Python's len and the schema's maxLength count it. */
const length = (value: string) => [...value].length

function text(
  body: Record<string, unknown>,
  field: keyof typeof LIMITS,
  required = false,
): string | undefined {
  let value = body[field]
  if (value === undefined || value === null) {
    if (required) throw new NoticeError(field, `${field} is required`)
    return undefined
  }
  if (typeof value !== 'string') throw new NoticeError(field, `${field} must be a string`)
  if (field === 'if_ignored') value = value.trim()
  const limit = LIMITS[field] as { min?: number; max?: number; pattern?: RegExp }
  const size = length(value as string)
  if (size < (limit.min ?? 0) || (limit.max !== undefined && size > limit.max))
    throw new NoticeError(
      field,
      `${field} must be ${limit.min ?? 0} to ${limit.max ?? 'any'} characters`,
    )
  if (limit.pattern && !limit.pattern.test(value as string))
    throw new NoticeError(field, `${field} does not match ${limit.pattern.source}`)
  return value as string
}

function seconds(body: Record<string, unknown>, field: 'cooldown' | 'expires'): number | undefined {
  const value = body[field]
  if (value === undefined || value === null) return undefined
  const { min, max } = LIMITS[field]
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max)
    throw new NoticeError(field, `${field} is seconds, ${min} to ${max}`)
  return value
}

function fields(value: unknown): Field[] {
  if (value === undefined || value === null) return []
  if (!Array.isArray(value) || value.length > LIMITS.fields.max)
    throw new NoticeError('fields', `fields is a list of at most ${LIMITS.fields.max}`)
  return value.map((item) => {
    const field = item as Record<string, unknown>
    if (
      !item ||
      typeof item !== 'object' ||
      Array.isArray(item) ||
      Object.keys(field).sort().join() !== 'label,value'
    )
      throw new NoticeError('fields', 'each field is {"label": ..., "value": ...}')
    for (const part of ['label', 'value'] as const) {
      const max = LIMITS.fields[part]
      const text = field[part]
      if (typeof text !== 'string' || length(text) < 1 || length(text) > max)
        throw new NoticeError('fields', `field ${part} must be 1 to ${max} characters`)
    }
    return { label: field.label as string, value: field.value as string }
  })
}

function oneOf<T extends string>(value: unknown, field: string, values: readonly T[]): T {
  if (typeof value !== 'string' || !(values as readonly string[]).includes(value))
    throw new NoticeError(field, `${field} must be one of ${values.join(', ')}`)
  return value as T
}

/** The notice in `value`, defaults filled in; throws NoticeError saying what to change. */
export function parseNotice(value: unknown): Notice {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new NoticeError('notice', 'a notice is one JSON object')
  const body = value as Record<string, unknown>
  const extra = Object.keys(body).find((key) => !FIELDS.has(key))
  if (extra) throw new NoticeError(extra, `a notice has no field ${extra}`)
  if (body.v !== 1) throw new NoticeError('v', 'v must be 1')
  const source = text(body, 'source', true) as string
  const title = text(body, 'title', true) as string
  const noticeBody = text(body, 'body', true) as string
  for (const [field, value] of [
    ['title', title],
    ['body', noticeBody],
  ] as const) {
    const left = UNFILLED.exec(value)
    if (left) throw new NoticeError(field, `${field} has an unfilled template field: ${left[0]}`)
  }
  const kind = oneOf(body.kind ?? 'alert', 'kind', KINDS)
  let severity = oneOf(body.severity ?? 'info', 'severity', SEVERITIES)
  const notice: Notice = {
    v: 1,
    source,
    kind,
    severity,
    title,
    body: noticeBody,
    fields: [],
    actions: [],
    primary: '',
    push: 'tray',
    cooldown: DEFAULT_COOLDOWN_S,
  }
  for (const field of ['detail', 'key', 'open', 'command', 'if_ignored'] as const) {
    const value = text(body, field)
    if (value) notice[field] = value
  }
  for (const field of ['command', 'if_ignored'] as const)
    if (notice[field]?.includes('\n')) throw new NoticeError(field, `${field} is one line`)
  notice.fields = fields(body.fields)

  const actions = body.actions ?? []
  if (
    !Array.isArray(actions) ||
    new Set(actions).size !== actions.length ||
    actions.some((action) => !(ACTIONS as readonly unknown[]).includes(action))
  )
    throw new NoticeError('actions', `actions are distinct picks from: ${ACTIONS.join(', ')}`)
  const picked = actions as NoticeAction[]
  const keyed = picked.filter((action) => (KEYED as readonly string[]).includes(action))
  if (keyed.length && !notice.key)
    throw new NoticeError('actions', `${keyed.join(', ')} need a key (what the answer is about)`)
  if ((picked.includes('expected') || picked.includes('not-expected')) && kind !== 'alert')
    throw new NoticeError('actions', 'expected and not-expected answer an alert, nothing else')
  if (picked.includes('answer') && !(kind === 'question' && ASK_LINK.test(notice.open ?? '')))
    throw new NoticeError('actions', 'answer is for a question whose open link is its Aico ask')
  if (picked.includes('done') && kind !== 'todo' && kind !== 'alert')
    throw new NoticeError('actions', 'done is for a todo or an alert the owner acts on')
  notice.actions = picked

  if (body.primary !== undefined && body.primary !== null) {
    if (!picked.includes(body.primary as NoticeAction))
      throw new NoticeError('primary', 'primary must be one of the actions')
    notice.primary = body.primary as NoticeAction
  }
  const push =
    body.push === undefined || body.push === null || body.push === ''
      ? severity === 'warning' || severity === 'critical'
        ? 'phone'
        : 'tray'
      : oneOf(body.push, 'push', PUSH)
  // The one owner-approved info push: Aico's own morning digest, once a day.
  const digest = source === 'aico' && kind === 'info' && notice.key?.startsWith('digest:') === true
  if (push === 'phone' && (severity === 'info' || severity === 'ok') && !digest)
    throw new NoticeError(
      'push',
      'info and ok stay on the desktop; the phone gets warnings and criticals',
    )
  notice.push = push
  // A todo is something to do: below warning it would never be listed. Raised after the route is picked.
  if (kind === 'todo' && (severity === 'info' || severity === 'ok')) severity = 'warning'
  notice.severity = severity
  notice.cooldown = seconds(body, 'cooldown') ?? DEFAULT_COOLDOWN_S
  const expires = seconds(body, 'expires')
  if (expires !== undefined) notice.expires = expires
  return notice
}

/** Whether the owner can answer it: an alert offering "That was me". */
export function asksVerdict(notice: Notice): boolean {
  return notice.kind === 'alert' && notice.actions.includes('expected')
}

/**
 * Whether the notice asks the owner something, so it shows in Needs you as an ask: a todo, an
 * alert offering "That was me", or a question that is not already an Aico ask (its open link).
 */
export function asksOwner(notice: Notice): boolean {
  if (notice.kind === 'question') return !ASK_LINK.test(notice.open ?? '')
  return notice.kind === 'todo' || asksVerdict(notice)
}
