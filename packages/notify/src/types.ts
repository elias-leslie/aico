// The notification types the owner switches in Settings > Notifications. Every notice files under
// exactly one: a row of this table, or `source:<source>` for a sender the table doesn't name, which
// shows up by itself the first time it sends. So nothing can bypass the owner's choice by being
// unknown. Order matters: the first match wins, and OmniNull's page, a test and an interrupt reason
// outrank the sender's key. A row's `phone` and `desktop` say what today's rule does for it when the
// owner has made no choice (phone.ts); a row kept off here is off at the door too (choices.ts).

import { isTestNotice } from './phone'

export interface NoticeType {
  id: string
  label: string
  /** One line, for the tooltip. */
  hint: string
  phone: boolean
  desktop: boolean
  /** At most this many phone pushes a calendar day; the rest stay in the tray (owner's call, per type). */
  phonePerDay?: number
  /** On is the rule's route and nothing more: this row never reaches the owner by the switch alone. */
  ruleOnly?: boolean
}

/** The part of a notice its type depends on. */
export interface Classified {
  source: string
  kind: string
  title: string
  key?: string | undefined
  interrupt?: string | undefined
  lab?: boolean | undefined
  fields?: readonly { label: string; value: string }[]
}

interface Rule extends NoticeType {
  match(notice: Classified, prefix: string): boolean
}

const key =
  (...prefixes: string[]) =>
  (_: Classified, prefix: string) =>
    prefixes.includes(prefix)
const source =
  (...names: string[]) =>
  (notice: Classified) =>
    names.includes(notice.source)
const reason = (name: string) => (notice: Classified) => notice.interrupt === name
/** An OmniNull page: the hub's `lab` flag, or a rule that only a lab machine can break (older pages). */
const hubPage = (notice: Classified, prefix: string) =>
  notice.source === 'ominull' && prefix === 'alerts'
const onLab = (notice: Classified) =>
  notice.lab === true ||
  notice.fields?.some(({ label, value }) => label === 'Rule' && value === 'lab escape') === true

const RULES: readonly Rule[] = [
  {
    id: 'tests',
    label: 'Tests',
    hint: "An agent's test. Only the documented phone test (a title starting Test:) reaches the phone.",
    ruleOnly: true,
    phone: true,
    desktop: true,
    match: (notice, prefix) => isTestNotice(notice.source, prefix, notice.title),
  },
  {
    id: 'security-lab',
    label: 'Security alerts: lab machines',
    hint: 'OmniNull pages about a lab machine, such as a drill on a test VM.',
    phone: true,
    desktop: true,
    match: (notice, prefix) => hubPage(notice, prefix) && onLab(notice),
  },
  {
    id: 'security-real',
    label: 'Security alerts: real machines',
    hint: 'OmniNull pages about any machine that is not in the lab.',
    phone: true,
    desktop: true,
    match: hubPage,
  },
  {
    id: 'canary',
    label: 'Canary tripped',
    hint: 'Something touched a decoy credential.',
    phone: true,
    desktop: true,
    match: key('canary'),
  },
  {
    id: 'agent-waiting',
    label: 'Agent waiting',
    hint: 'A session has waited on you for a while with nobody looking at it.',
    phone: true,
    desktop: true,
    match: key('aico-waiting'),
  },
  {
    id: 'agent-question',
    label: 'Agent question',
    hint: 'An agent asked you something and stopped for the answer.',
    phone: true,
    desktop: true,
    match: (notice, prefix) => prefix === 'ask' || notice.kind === 'question',
  },
  {
    id: 'approval',
    label: 'Approval taps',
    hint: 'An agent asks for timed access. Silenced, the request still waits in the tray.',
    phone: true,
    desktop: true,
    match: key('approve'),
  },
  {
    id: 'model-switch',
    label: 'Model switched',
    hint: 'A session moved off the model it was started on.',
    phone: true,
    desktop: true,
    match: key('aico-model'),
  },
  {
    id: 'backup',
    label: 'Backup at risk',
    hint: 'A backup stayed failed or late past its retry.',
    phone: true,
    desktop: true,
    match: reason('data-risk'),
  },
  {
    id: 'outage',
    label: 'Machine or service down',
    hint: 'An always-on machine or service stayed down, including the alarm Proxmox sends when Aico stops checking in.',
    phone: true,
    desktop: true,
    match: reason('outage'),
  },
  {
    id: 'status',
    label: 'Status changes',
    hint: 'A Status row went late or failed. Major ones that last are the two rows above.',
    phone: false,
    desktop: false,
    match: key('status', 'status-sustained'),
  },
  {
    id: 'school-check',
    label: 'School check',
    hint: "The school portal routine's report. At most one phone push a day.",
    phone: true,
    desktop: true,
    phonePerDay: 1,
    match: source('school-check'),
  },
  {
    id: 'reminder',
    label: 'Reminders',
    hint: 'A reminder you set on a note.',
    phone: true,
    desktop: true,
    match: key('reminder'),
  },
  {
    id: 'digest',
    label: 'Morning digest',
    hint: 'What happened while you were away, once a day.',
    phone: true,
    desktop: false,
    match: key('digest'),
  },
  {
    id: 'jobinator',
    label: 'Jobinator follow-ups',
    hint: 'Job follow-ups that are due.',
    phone: false,
    desktop: true,
    match: source('jobinator-4000'),
  },
  {
    id: 'portfolio',
    label: 'Portfolio over-plan',
    hint: 'Spending is heading over plan.',
    phone: false,
    desktop: false,
    match: source('portfolio-ai'),
  },
  {
    id: 'browser',
    label: 'Browser needs you',
    hint: 'A browser session stopped for a login or a captcha.',
    phone: false,
    desktop: true,
    match: source('browser-automation'),
  },
  {
    id: 'unused-context',
    label: 'Unused context',
    hint: 'Context items no session has used.',
    phone: false,
    desktop: false,
    match: key('context-unused'),
  },
]

/** Every row the table names, in the order Settings lists them. */
export const NOTICE_TYPES: readonly NoticeType[] = RULES.map(({ match: _match, ...type }) => type)

const DYNAMIC = 'source:'

/** The first part of a key: `alerts:abc,def` and `aico-waiting:1234` name what they are about. */
function keyPrefix(key: string | undefined): string {
  return key?.split(':')[0] ?? ''
}

/** The type a notice files under: a row of the table, or `source:<source>`. */
export function typeOf(notice: Classified): string {
  const prefix = keyPrefix(notice.key)
  return RULES.find((rule) => rule.match(notice, prefix))?.id ?? `${DYNAMIC}${notice.source}`
}

/** The row for a type: the table's, or one made for a sender the table doesn't name. */
export function describeType(id: string): NoticeType {
  const known = NOTICE_TYPES.find((type) => type.id === id)
  if (known) return known
  const name = id.startsWith(DYNAMIC) ? id.slice(DYNAMIC.length) : id
  return {
    id,
    label: name === 'aico' ? 'Other Aico notices' : name,
    hint: `Notices from ${name}, a sender with no type of its own yet.`,
    // What the rule did with it is read from its notices (notifications in web-server).
    phone: false,
    desktop: false,
  }
}

/** A type id Settings can save: a table row, or a sender by the contract's source pattern. */
export function validTypeId(id: string): boolean {
  return (
    NOTICE_TYPES.some((type) => type.id === id) ||
    (id.startsWith(DYNAMIC) && /^[a-z0-9][a-z0-9-]{0,39}$/.test(id.slice(DYNAMIC.length)))
  )
}
