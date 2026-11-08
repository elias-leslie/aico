// Saved logins as the page reads them: the server's shapes, the call, and how a login is named and described.

import type { Chip } from '@/components/settings/kit'
import { shortWhen } from './short-when'

export const kinds = [
  'tool login',
  'API key',
  'password',
  'backup key',
  'lab login',
] as const
export type Kind = (typeof kinds)[number]
/** What the Add form offers: the kinds plus account logins (a username, password and login page). */
export const ACCOUNT = 'account login'
export type Choice = Kind | typeof ACCOUNT
export const groups = [
  ACCOUNT,
  ...kinds.filter((k) => k !== 'lab login'),
  'lab login',
] as const
export const groupOf = (e: Entry): Choice =>
  e.lab?.kind === 'account' ? ACCOUNT : e.kind
export interface Entry {
  /** Set when a tool's login is delivered from this one; its kind then stays tool login. */
  tool?: unknown
  name: string
  kind: Kind
  notes: string
  state: string
  machines: string[]
  roles: string[]
  deniedRoles?: string[]
  created: string
  rotated: string | null
  lastUsed: string | null
  verifierOnly?: boolean
  lab?: {
    target: string
    actor: string
    kind: string
    fields: string[]
    expires_at: string | null
    username?: string
    login_url?: string
    huntersOk?: boolean
  }
}
export interface Event {
  at: string
  action: string
  name: string
  actor: string
  detail?: string
}
/** A saved login page that shows no password field, and the page that does when one was found. */
export interface Probe {
  password: boolean
  suggestion: string | null
  warning: string
}
/** What the page last checked, for one login. */
export interface Checked extends Probe {
  name: string
  /** Shown in the login's own row (after Edit) rather than at the top (after Add). */
  inRow?: boolean
}
export interface Data {
  entries: Entry[]
  /** This computer's name: where a new login is allowed until changed. */
  machine?: string
  assignments: Record<string, string[]>
  revealSeconds: number
  readOnly?: boolean
  warning?: string
}

/** The name a login's row shows: a lab login's site, else the login's own name. */
export const shownName = (entry: Entry) =>
  entry.lab ? entry.lab.target : entry.name

/** Where a lab login's fields are read and changed. */
export const labPath = (entry: Entry) =>
  `/api/logins/lab/${entry.lab?.target}/${entry.lab?.actor}`

/** A login among others in a chooser: several logins of one site read apart by their account. */
export const sourceLabel = (entry: Entry, all: readonly Entry[]) => {
  if (!entry.lab) return entry.name
  const { target, username } = entry.lab
  return all.filter((other) => other.lab?.target === target).length > 1
    ? `${target} · ${username || entry.name.slice(entry.name.lastIndexOf('--') + 2)}`
    : target
}

export async function api<T = { warning?: string }>(
  path: string,
  body?: unknown,
  method = 'POST',
): Promise<T> {
  const response = await fetch(
    path,
    body === undefined
      ? { cache: 'no-store' }
      : {
          method,
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body),
          cache: 'no-store',
        },
  )
  const result = await response.json()
  if (!response.ok)
    throw new Error(result.detail || 'Logins could not complete the operation.')
  return result as T
}

export const title = (kind: Choice) =>
  ({
    [ACCOUNT]: 'Account logins',
    'tool login': 'Tool logins',
    'API key': 'API keys',
    password: 'Passwords',
    'backup key': 'Backup keys',
    'lab login': 'Lab logins',
  })[kind]
export const when = (time: string | null) => shortWhen(time)
export const characters = (n: number) =>
  `${n} ${n === 1 ? 'character' : 'characters'}`
/** The confirmation after a value is stored: its length only, never the value. */
export const savedChars = (value: string) =>
  `Saved, ${characters([...value].length)}`

const CHIP: Record<string, Chip> = {
  'In use': 'ok',
  Unused: 'off',
  Expired: 'failed',
  'Needs sign-in': 'late',
  Unavailable: 'failed',
}
export const chipOf = (state: string): Chip => CHIP[state] ?? 'off'
export const STATE_TIP: Record<string, string> = {
  'In use': 'An agent has used this login.',
  Unused:
    'Saved, but no agent has used it yet. A program that reads it directly, like a backup, doesn’t count here.',
  Expired: 'Past its end date: agents can no longer use it.',
  'Needs sign-in': 'Its tool is signed out on this computer: sign in again.',
  Unavailable: 'Its saved value is missing on this computer: replace it.',
  'Held on VM 180':
    'The login itself lives on VM 180; this computer keeps only a way to check it.',
}
export const metaTip = (entry: Entry) =>
  entry.lab
    ? `For the ${entry.lab.actor === 'default' ? 'default' : `“${entry.lab.actor}”`} user of ${entry.lab.target}; ${
        entry.lab.kind === 'account'
          ? 'an account login (username and password)'
          : `a ${entry.lab.kind}`
      }`
    : undefined
export const meta = (entry: Entry) =>
  entry.lab
    ? `${entry.lab.actor} · ${entry.lab.kind}${
        entry.lab.expires_at ? ` · Expires ${when(entry.lab.expires_at)}` : ''
      }`
    : `Last used: ${when(entry.lastUsed)}`

/** Sessions by id, so activity names the session rather than its id. */
export type Who = { id: string; label: string }[]
/** A lab login as its row names it: `_lab_example.com--default` is example.com;
 * another account on the site adds its name. */
const shownEventName = (name: string) => {
  const lab = name.match(
    /^_lab_([a-z0-9][a-z0-9._-]{0,79})--([a-z0-9][a-z0-9._-]{0,49})$/,
  )
  if (!lab) return name
  return lab[2] === 'default' ? lab[1] : `${lab[1]} · ${lab[2]}`
}
const ACTION_WORDS: Record<string, string> = {
  set: 'added',
  rotate: 'replaced',
}
/** One activity line: when, what, which login, who, and what changed when it says. */
export const eventLine = (e: Event, named = true, who: Who = []) =>
  [
    when(e.at),
    ACTION_WORDS[e.action] ?? e.action,
    named ? shownEventName(e.name) : null,
    who.find((s) => s.id === e.actor)?.label ?? e.actor,
    e.detail,
  ]
    .filter(Boolean)
    .join(' · ')
