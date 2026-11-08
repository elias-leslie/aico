'use client'

import { useState } from 'react'
import { Quiet } from './settings/kit'
import kit from './settings/kit.module.css'

/** The grants a login carries, as the server lists them. */
export interface Grants {
  machines: string[]
  roles: string[]
  deniedRoles?: string[]
}
/**
 * What the checklists show: ticked machines, whether every role is allowed, the ticked roles,
 * the roles named on the login itself (kept next to "All roles"; a lab login needs one), and the
 * sessions assigned to a lab login's target.
 */
export interface Access {
  machines: string[]
  all: boolean
  roles: string[]
  named: string[]
  sessions: string[]
}
/** One grant or revoke the server needs to turn the current access into the chosen one. */
export interface GrantOp {
  type: 'machine' | 'role'
  value: string
  granted: boolean
}
/** Another login the form can copy access from. */
export interface AccessSource extends Grants {
  name: string
  label: string
  /** A lab login's target; its session assignments copy with it. */
  target?: string
}
/** What the checklists are built from. */
export interface AccessChoices {
  sources: AccessSource[]
  /** Linked machines the page loaded. */
  hosts: string[]
  hostsStatus: 'loading' | 'error' | 'ready'
  /** Work roles the server registers. */
  registered: string[]
  registeredFailed: boolean
  /** This computer's name: where a new login is allowed until changed. */
  machine: string
  /** Sessions a lab target can be assigned to, and who has which target now. */
  sessions: { id: string; label: string }[]
  sessionsFailed: boolean
  assignments: Record<string, string[]>
}

const ALL = '*'
const unique = (items: string[]) => [...new Set(items)]
const NAME = /^[A-Za-z0-9_.-]{1,128}$/

/** The ticks for a login: with "All roles" on, every known role is ticked except the blocked ones. */
export function accessOf(
  grants: Grants,
  known: string[],
  sessions: string[] = [],
): Access {
  const all = grants.roles.includes(ALL),
    explicit = grants.roles.filter((r) => r !== ALL),
    denied = grants.deniedRoles ?? []
  return {
    machines: [...grants.machines],
    all,
    roles: all
      ? unique([...explicit, ...known.filter((r) => !denied.includes(r))])
      : explicit,
    named: explicit,
    sessions,
  }
}

/** The sessions whose assignments include this lab target. */
export const sessionsOf = (choices: AccessChoices, target?: string) =>
  target
    ? choices.sessions
        .filter((s) => choices.assignments[s.id]?.includes(target))
        .map((s) => s.id)
    : []

/** One session's new target list, where its membership of `target` has to change. */
export interface AssignOp {
  session: string
  label: string
  targets: string[]
  granted: boolean
}
export function planSessions(
  choices: AccessChoices,
  target: string,
  wanted: string[],
): AssignOp[] {
  const ops: AssignOp[] = []
  for (const s of choices.sessions) {
    const targets = choices.assignments[s.id] ?? [],
      has = targets.includes(target),
      want = wanted.includes(s.id)
    if (has !== want)
      ops.push({
        session: s.id,
        label: s.label,
        granted: want,
        targets: want
          ? [...targets, target]
          : targets.filter((t) => t !== target),
      })
  }
  return ops
}

/** Runs the assignments through the owner-only assign endpoint; returns what failed and why. */
export async function applySessions(
  ops: AssignOp[],
  send: (path: string, body: unknown) => Promise<unknown>,
): Promise<string[]> {
  const failed: string[] = []
  for (const op of ops)
    try {
      await send('/api/logins/assign', {
        session: op.session,
        targets: op.targets,
      })
    } catch (error) {
      failed.push(
        `Could not ${op.granted ? 'give' : 'take away'} access for ${op.label} (session): ${(error as Error).message}`,
      )
    }
  return failed
}

/** The grants and revokes that turn `current` into `wanted`, following the server's own rules for "All roles". */
export function planAccess(
  current: Grants,
  wanted: Access,
  known: string[],
): GrantOp[] {
  const ops: GrantOp[] = []
  const machines = new Set(current.machines)
  const roles = new Set(current.roles)
  const denied = new Set(current.deniedRoles ?? [])
  const role = (value: string, granted: boolean) => {
    ops.push({ type: 'role', value, granted })
    roles.delete(value)
    if (value !== ALL) denied.delete(value)
    if (granted) roles.add(value)
    else if (value !== ALL && roles.has(ALL)) denied.add(value)
  }
  const allowed = (value: string) =>
    roles.has(value) || (roles.has(ALL) && !denied.has(value))
  for (const value of current.machines)
    if (!wanted.machines.includes(value)) {
      ops.push({ type: 'machine', value, granted: false })
      machines.delete(value)
    }
  for (const value of wanted.machines)
    if (!machines.has(value))
      ops.push({ type: 'machine', value, granted: true })
  if (wanted.all !== roles.has(ALL)) role(ALL, wanted.all)
  const names = unique([
    ...known,
    ...current.roles,
    ...(current.deniedRoles ?? []),
    ...wanted.roles,
  ]).filter((r) => r !== ALL)
  const named = new Set(wanted.named)
  for (const value of names) {
    const want = wanted.roles.includes(value)
    if (want && !allowed(value)) role(value, true)
    // A named role stays named next to "All roles": a lab login is opened by it, not by "*".
    else if (want && wanted.all && named.has(value) && !roles.has(value))
      role(value, true)
    else if (!want && allowed(value)) role(value, false)
  }
  // Exact copy: a role named here but not on the wanted login goes back to counting through "All roles".
  const drop = [...roles].filter(
    (r) => r !== ALL && wanted.all && wanted.roles.includes(r) && !named.has(r),
  )
  if (drop.length) {
    role(ALL, false)
    for (const value of drop) role(value, false)
    role(ALL, true)
  }
  return ops
}

/** Every role the checklist can offer: the registered ones, then any already on a login. */
export const knownRoles = (choices: AccessChoices) =>
  unique([
    ...choices.registered,
    ...choices.sources.flatMap((s) => [...s.roles, ...(s.deniedRoles ?? [])]),
  ]).filter((r) => r !== ALL)

/** A new login starts where the server puts it: this computer, every role. */
export const defaultAccess = (choices: AccessChoices): Access =>
  accessOf(
    {
      machines: choices.machine ? [choices.machine] : [],
      roles: [ALL],
    },
    knownRoles(choices),
  )

const describe = (op: GrantOp) =>
  `${op.granted ? 'allow' : 'remove'} ${op.value === ALL ? 'all roles' : op.value}`

/** Runs the plan through the grants endpoint one item at a time; returns what failed and why. */
export async function applyAccess(
  path: string,
  ops: GrantOp[],
  send: (path: string, body: unknown) => Promise<unknown>,
): Promise<string[]> {
  const failed: string[] = []
  for (const op of ops)
    try {
      await send(`${path}/grants`, {
        type: op.type,
        value: op.value,
        granted: op.granted,
      })
    } catch (error) {
      failed.push(
        `Could not ${describe(op)} (${op.type}): ${(error as Error).message}`,
      )
    }
  return failed
}

/** Machines and roles to tick, plus "Same access as" to copy another login's. */
export function AccessChecklist({
  choices,
  value,
  onChange,
  exclude,
  disabled,
  lab,
  account,
}: {
  choices: AccessChoices
  value: Access
  onChange(next: Access): void
  /** A lab login: sessions join its roles in one "Used by" list. */
  lab?: boolean
  /** An account login: "All roles" opens it too (other lab logins need a named role or session). */
  account?: boolean
  /** The login being edited, left out of "Same access as". */
  exclude?: string
  disabled?: boolean
}) {
  const [other, setOther] = useState(''),
    [copied, setCopied] = useState(''),
    [extra, setExtra] = useState<string[]>([])
  const { sources, registered } = choices
  const machines = unique([
    ...choices.hosts,
    ...sources.flatMap((s) => s.machines),
    ...value.machines,
  ])
  const roles = unique([
    ...registered,
    ...sources.flatMap((s) => [...s.roles, ...(s.deniedRoles ?? [])]),
    ...extra,
    ...value.roles,
  ]).filter((r) => r !== ALL)
  const copyFrom = (name: string) => {
    setCopied(name)
    const source = sources.find((s) => s.name === name)
    if (!source) return
    const known = unique([...registered, ...roles])
    onChange(
      accessOf(
        source,
        known,
        lab && source.target
          ? sessionsOf(choices, source.target)
          : value.sessions,
      ),
    )
  }
  // A lab login other than an account login opens only for a role named on it, never "All roles".
  const allRoles = !lab || !!account
  const ticked = (role: string) =>
    allRoles ? value.roles.includes(role) : value.named.includes(role)
  const toggle = (list: string[], item: string, on: boolean) =>
    on ? unique([...list, item]) : list.filter((v) => v !== item)
  return (
    <>
      <label>
        Same access as
        <select
          value={copied}
          disabled={disabled}
          onChange={(e) => copyFrom(e.target.value)}
        >
          <option value="">Choose a login</option>
          {sources
            .filter((s) => s.name !== exclude)
            .map((s) => (
              <option key={s.name} value={s.name}>
                {s.label}
              </option>
            ))}
        </select>
      </label>
      <fieldset disabled={disabled}>
        <legend>Machines</legend>
        {choices.hostsStatus === 'loading' && (
          <Quiet role="status">Checking machines…</Quiet>
        )}
        {choices.hostsStatus === 'error' && (
          <Quiet role="alert">Machines could not load.</Quiet>
        )}
        {choices.hostsStatus === 'ready' && machines.length === 0 && (
          <Quiet>No linked machines are available.</Quiet>
        )}
        <div className={kit.checks}>
          {machines.map((m) => (
            <label className={kit.check} key={m}>
              <input
                type="checkbox"
                checked={value.machines.includes(m)}
                onChange={(e) => {
                  setCopied('')
                  onChange({
                    ...value,
                    machines: toggle(value.machines, m, e.target.checked),
                  })
                }}
              />
              {m}
            </label>
          ))}
        </div>
      </fieldset>
      <fieldset disabled={disabled}>
        <legend>{lab ? 'Used by' : 'Roles'}</legend>
        {choices.registeredFailed && (
          <Quiet role="alert">Roles could not load.</Quiet>
        )}
        {lab && choices.sessionsFailed && (
          <Quiet role="alert">Sessions could not load.</Quiet>
        )}
        <div className={kit.checks}>
          {allRoles && (
            <label className={kit.check}>
              <input
                type="checkbox"
                checked={value.all}
                onChange={(e) => {
                  setCopied('')
                  onChange({
                    ...value,
                    all: e.target.checked,
                    roles: e.target.checked ? roles : value.roles,
                    named: value.all ? value.named : value.roles,
                  })
                }}
              />
              All roles
            </label>
          )}
          {roles.map((r) => (
            <label
              className={kit.check}
              key={r}
              title={
                allRoles && value.all && !value.roles.includes(r)
                  ? 'Blocked'
                  : undefined
              }
            >
              <input
                type="checkbox"
                checked={ticked(r)}
                onChange={(e) => {
                  setCopied('')
                  onChange({
                    ...value,
                    roles: toggle(value.roles, r, e.target.checked),
                    // Allowing a role by hand names it, also under "All roles".
                    named: toggle(value.named, r, e.target.checked),
                  })
                }}
              />
              {r}
              {allRoles &&
                value.all &&
                value.roles.includes(r) &&
                isNamed(r) && (
                  <span
                    className={kit.named}
                    role="img"
                    aria-label="Named"
                    title="Named on this login. It still counts if All roles is turned off, and a lab login needs it."
                  />
                )}
            </label>
          ))}
          {lab &&
            choices.sessions.map((s) => (
              <label
                className={kit.check}
                key={`session-${s.id}`}
                title="Session"
              >
                <input
                  type="checkbox"
                  checked={value.sessions.includes(s.id)}
                  onChange={(e) => {
                    setCopied('')
                    onChange({
                      ...value,
                      sessions: toggle(value.sessions, s.id, e.target.checked),
                    })
                  }}
                />
                <span
                  className={kit.sessionMark}
                  role="img"
                  aria-label="Session"
                />
                {s.label}
              </label>
            ))}
        </div>
        <label>
          Other role
          <input
            value={other}
            autoComplete="off"
            placeholder="Role name"
            onChange={(e) => setOther(e.target.value)}
            onKeyDown={(e) => {
              if (e.key !== 'Enter') return
              e.preventDefault()
              addOther()
            }}
          />
        </label>
        <button
          type="button"
          className="lantern-btn small"
          disabled={!NAME.test(other.trim())}
          onClick={addOther}
        >
          Add role
        </button>
      </fieldset>
    </>
  )
  function isNamed(role: string) {
    return value.named.includes(role)
  }
  function addOther() {
    const name = other.trim()
    if (!NAME.test(name)) return
    setExtra(unique([...extra, name]))
    onChange({
      ...value,
      roles: unique([...value.roles, name]),
      named: unique([...value.named, name]),
    })
    setOther('')
  }
}
