// The Machines page's data: every machine once, from the Status machine rows and the hosts
// sessions can run on (Tether's links). Pure; the page fetches and renders.

import type { HostChoice } from './hooks/use-hosts'
import type { MachineGuest } from './hooks/use-machine-guests'
import { MACHINE_LABEL, WORKSTATION_LABEL } from './machine-name'
import {
  ago,
  at,
  isProblem,
  plural,
  reason,
  type StatusRow,
  type StatusView,
} from './status'

/** The session host that is this computer: `New session` and the hosts list name it only by omission. */

/** Session hosts whose Tether name is not the machine's own name (data, from the Tether hosts
 * file). None now: the `aico` link reaches CT 190 (the aico-gem ssh alias), which is its own machine. */
const SESSION_HOST_MACHINE: Record<string, string> = {}

/** What a machine is for, where Aico's data does not already say. */
const PURPOSE: Record<string, string> = {
  'davion-sidarli': 'Runs Aico, your agents and their projects.',
  'davion-gem': 'Runs the VMs and containers. Its watchdog reports to Aico.',
  aico: 'The standby: a second Aico on its own container (CT 190) that keeps working while the workstation is down.',
  'neri-hunters': 'The security hunt.',
  'ominull-hub': 'Detection and paging (OmniNull).',
  apps: 'Portfolio and other apps.',
  jobinator: 'Job scans and screening (Jobinator).',
}
const SESSION_HOST_PURPOSE = 'Runs sessions away from the workstation.'

/** The standby machine and the Status rows that keep it ready: its link, its release, the copy of
 * the owner's context, and the repo copies and checkouts sent to it. */
const STANDBY = {
  machine: 'aico',
  rows: [
    /^fleet\/[^/]+\/aico$/,
    /^jobs\/peer-release$/,
    /^jobs\/context-sync$/,
    /^jobs\/wip-mirror-/,
    /\/wip-mirror\//,
  ],
}

/** What the standby badge's tooltip says it does. */
export const STANDBY_TIP =
  'Standby: keeps working while the workstation is down. It runs the same release, gets copies of your memories, prompts and projects, and runs note reminders and the morning digest.'

/** Whether the standby is ready to take over: every row that keeps it ready is fine; `behind` names
 * the ones that are not. */
export interface Standby {
  ready: boolean
  behind: string[]
}

function standbyOf(rows: readonly StatusRow[]): Standby {
  const behind = rows
    .filter(
      (row) =>
        STANDBY.rows.some((pattern) => pattern.test(row.id)) &&
        isProblem(row.shown),
    )
    .map((row) => `${row.what}: ${row.meaning}`)
  return { ready: behind.length === 0, behind }
}

/** What a session host is called in lists of places to start a session. */
export function sessionHostLabel(name: string | null): string {
  if (name === null) return WORKSTATION_LABEL
  const machine = SESSION_HOST_MACHINE[name] ?? name
  return MACHINE_LABEL[machine] ?? name
}

export type Up =
  | 'on'
  | 'off'
  | 'starting'
  | 'stopping'
  | 'restarting'
  | 'connecting'
  | 'unreachable'
  | 'changed'
  | 'late'
  | 'unknown'
  | 'failed'

export const UP_WORD: Record<Up, string> = {
  on: 'On',
  off: 'Off',
  starting: 'Starting',
  stopping: 'Shutting down',
  restarting: 'Restarting',
  connecting: 'Connecting',
  unreachable: 'Unreachable',
  changed: 'Changed',
  late: 'Not reporting',
  unknown: 'Unknown',
  failed: 'Failed',
}

/** The status chip class each state shares with Status. */
export const UP_CHIP: Record<Up, string> = {
  on: 'ok',
  off: 'off',
  starting: 'warn',
  stopping: 'warn',
  restarting: 'warn',
  connecting: 'warn',
  unreachable: 'late',
  changed: 'warn',
  late: 'late',
  unknown: 'unknown',
  failed: 'failed',
}

export interface Machine {
  /** The machine's own name, one per machine. */
  key: string
  /** What the page calls it. */
  name: string
  up: Up
  /** What it is for. */
  purpose: string
  /** Why it is in this state, or when it last reported. */
  note: string
  /** Sessions can run here. */
  sessionHost: boolean
  /** Sessions running here; null when not known. */
  sessions: number | null
  /** The session host's Tether name, for power. */
  host: string | null
  /** The one power action offered when Proxmox can't be asked, if any. */
  power: 'on' | 'off' | 'trust' | null
  isWorkstation: boolean
  /** Its Proxmox guest (power, autostart); null for the two computers and while Proxmox can't be read. */
  guest: MachineGuest | null
  /** Up since, size and projects, from Proxmox and the project registry; empty when not known. */
  facts: string
  /** The standby's readiness; null for every other machine, and while Status can't be read. */
  standby: Standby | null
}

const GUEST_FREE = new Set(['davion-gem'])

/** "Up 3 days", "Up 5 h", "Up 12 min". */
function uptime(since: string | null, now: number): string {
  const start = since ? Date.parse(since) : Number.NaN
  if (Number.isNaN(start)) return ''
  const minutes = Math.max(0, Math.round((now - start) / 60_000))
  if (minutes < 1) return 'Up just now'
  if (minutes < 60) return `Up ${minutes} min`
  if (minutes < 48 * 60) return `Up ${Math.round(minutes / 60)} h`
  return `Up ${Math.floor(minutes / 1440)} days`
}

const gb = (mb: number) =>
  `${Number.isInteger(mb / 1024) ? mb / 1024 : (mb / 1024).toFixed(1)} GB`

function guestFacts(guest: MachineGuest, now: number): string {
  const size = [
    guest.cpus ? plural(guest.cpus, 'CPU') : '',
    guest.memoryMb ? `${gb(guest.memoryMb)} RAM` : '',
  ]
    .filter(Boolean)
    .join(', ')
  const projects = guest.projects.length
    ? `${guest.projects.length === 1 ? 'Project' : 'Projects'}: ${guest.projects.map((p) => p.name).join(', ')}`
    : ''
  return [
    guest.state === 'running' ? uptime(guest.since, now) : '',
    size,
    projects,
  ]
    .filter(Boolean)
    .join(' · ')
}

/** Autostart and the registry's intent are two facts; this says so when they pull apart. */
export function autostartHint(guest: MachineGuest): string {
  if (guest.autostart === null) return 'Proxmox didn’t say.'
  if (guest.intent === 'always' && !guest.autostart)
    return 'Meant to be always on, but won’t start by itself after the Proxmox host reboots.'
  if (guest.intent === 'on-demand' && guest.autostart)
    return 'On demand, yet starts with the Proxmox host.'
  return ''
}

/** Said once at the top of the page, not on every row. */
export const MACHINES_LEGEND = [
  'Autostart: starts the machine when the Proxmox host boots.',
  'Runs sessions: you can start sessions on it.',
  'Always on, On demand, Parked: where the project registry says it should be.',
]

export const INTENT_TAG: Record<NonNullable<MachineGuest['intent']>, string> = {
  always: 'Always on',
  'on-demand': 'On demand',
  off: 'Parked',
}

/** What each registry tag means, for its tooltip. */
export const INTENT_TIP: Record<NonNullable<MachineGuest['intent']>, string> = {
  always:
    'Always on: meant to run all the time. Aico tells you when it stays down.',
  'on-demand': 'On demand: started when something needs it. Being off is fine.',
  off: 'Parked: meant to stay off.',
}

export interface Machines {
  machines: Machine[]
  /** Status couldn't be read: only session hosts are listed. */
  partial: boolean
  /** The session hosts couldn't be read: the tags come from this computer alone. */
  hostsUnknown: boolean
}

const isLink = (row: StatusRow) => row.id.startsWith('fleet/')

function upFromRow(row: StatusRow): Up {
  switch (row.shown) {
    case 'off':
      return 'off'
    case 'late':
      return 'late'
    case 'unknown':
      return 'unknown'
    case 'failed':
      return 'failed'
    default:
      return 'on'
  }
}

function upFromHost(host: HostChoice): Up {
  if (host.wake?.state === 'starting') return 'starting'
  switch (host.state) {
    case 'connected':
      return 'on'
    case 'connecting':
      return 'connecting'
    case 'powered_off':
      return 'off'
    case 'identity_changed':
      return 'changed'
    default:
      return 'unreachable'
  }
}

function powerFor(host: HostChoice | undefined): Machine['power'] {
  if (!host || host.wake?.state === 'starting') return null
  if (host.state === 'identity_changed') return 'trust'
  if (host.state !== 'connected') return 'on'
  return host.canSleep === false ? null : 'off'
}

function noteFor(
  up: Up,
  row: StatusRow | undefined,
  host: HostChoice | undefined,
  now: number,
): string {
  if (host?.wake?.state === 'failed')
    return host.wake.error
      ? `Didn’t start: ${host.wake.error}`
      : 'Didn’t start.'
  if (host?.wake?.state === 'starting') return 'Starting up…'
  if (up === 'changed') return 'Not the same machine as before.'
  if (up === 'unreachable' || up === 'connecting')
    return host?.error
      ? `Sessions can’t reach it: ${host.error}`
      : 'Sessions can’t reach it.'
  if (row && (up === 'late' || up === 'unknown' || up === 'failed')) {
    const why = reason(row)
    return `${why ? `${why} ` : ''}Last report ${at(Date.parse(row.updated_at), now)}.`
  }
  if (up === 'off') {
    const since = row?.shown_since
      ? Date.parse(row.shown_since)
      : (host?.since ?? null)
    if (since) return `Off since ${at(since, now)}.`
    // No time it went off: say when it last reported instead of leaving the line out.
    return row ? `Off. Last report ${at(Date.parse(row.updated_at), now)}.` : ''
  }
  if (row && !isLink(row))
    return `Reported ${ago(Date.parse(row.updated_at), now)}.`
  return ''
}

/** Proxmox knows better than a lagging report whether a guest is running or being stopped. */
function upWithGuest(
  up: Up,
  guest: MachineGuest,
  linked: boolean,
  powerOffByAico: boolean,
): Up {
  if (guest.busy === 'shutdown') return 'stopping'
  if (guest.busy === 'restart') return 'restarting'
  if (guest.busy === 'start' || guest.state === 'starting') return 'starting'
  // A reading that is a few seconds old must not undo a start Tether is following or a link
  // that is already up.
  if (
    (guest.state === 'stopped' || guest.state === 'down') &&
    up !== 'off' &&
    up !== 'starting' &&
    !linked
  )
    return 'off'
  // Proxmox says it is running while its link says it was powered off: that is a shutdown still
  // finishing; any other off link with a running guest is a boot the link has not caught up with.
  if (guest.state === 'running' && up === 'off')
    return powerOffByAico ? 'stopping' : 'starting'
  return up
}

/** Every machine once. `view` is null while Status can't be read, `hosts` null while the hosts can't. */
export function buildMachines(
  view: StatusView | null,
  hosts: HostChoice[] | null,
  now: number,
  guests: readonly MachineGuest[] | null = null,
): Machines {
  const workstationKey = view?.machine ?? WORKSTATION_LABEL
  const rows = (view?.rows ?? []).filter((row) => row.kind === 'machine')
  const own = new Map<string, StatusRow>()
  const links = new Map<string, StatusRow>()
  for (const row of rows) {
    if (isLink(row))
      links.set(SESSION_HOST_MACHINE[row.machine] ?? row.machine, row)
    else own.set(row.machine, row)
  }
  const hostOf = new Map<string, HostChoice>()
  for (const host of hosts ?? [])
    hostOf.set(SESSION_HOST_MACHINE[host.name] ?? host.name, host)

  const keys = new Set<string>([
    workstationKey,
    ...own.keys(),
    ...links.keys(),
    ...hostOf.keys(),
  ])
  const machines: Machine[] = [...keys].map((key) => {
    const isWorkstation = key === workstationKey
    const row = own.get(key)
    const link = links.get(key)
    const host = hostOf.get(key)
    let up: Up
    if (host?.state === 'connected' && host.wake?.state !== 'starting')
      up = 'on'
    else if (host?.wake?.state === 'starting') up = 'starting'
    else if (row) up = upFromRow(row)
    else if (host) up = upFromHost(host)
    else if (link) up = upFromRow(link)
    else up = 'on'
    const guest =
      isWorkstation || GUEST_FREE.has(key)
        ? null
        : (guests?.find((g) => g.machine === key) ?? null)
    if (guest)
      up = upWithGuest(
        up,
        guest,
        host?.state === 'connected',
        host?.state === 'powered_off',
      )
    const sessionHost = isWorkstation || !!host || (!!link && hosts === null)
    const sessionHostName = host?.name ?? null
    const note =
      guest?.state === 'down' && up === 'off'
        ? 'Stopped, but meant to be on.'
        : noteFor(up, row ?? link, host, now)
    return {
      key,
      name: isWorkstation ? WORKSTATION_LABEL : (MACHINE_LABEL[key] ?? key),
      up,
      purpose:
        PURPOSE[key] ??
        (host || link ? SESSION_HOST_PURPOSE : (row?.meaning ?? '')),
      note,
      sessionHost,
      sessions: host?.state === 'connected' ? (host.sessions ?? 0) : null,
      host: sessionHostName,
      power: powerFor(host),
      isWorkstation,
      guest,
      facts: guest ? guestFacts(guest, now) : '',
      standby: key === STANDBY.machine && view ? standbyOf(view.rows) : null,
    }
  })
  const rank = (m: Machine) =>
    m.isWorkstation ? 0 : m.key === 'davion-gem' ? 1 : m.sessionHost ? 2 : 3
  machines.sort((a, b) => rank(a) - rank(b) || (a.name < b.name ? -1 : 1))
  return { machines, partial: view === null, hostsUnknown: hosts === null }
}

/** How many machines these Status rows come from, counting one machine once under every name it
 * goes by (the same count the Machines page shows). */
export function machineCount(rows: readonly StatusRow[]): number {
  return new Set(
    rows.map((row) => SESSION_HOST_MACHINE[row.machine] ?? row.machine),
  ).size
}

/** "7 machines, 3 on. Sessions can run on 4 of them; 2 of those are on.", from the list as shown. */
export function machinesLine(list: Machines): string {
  const total = list.machines.length
  const hosts = list.machines.filter((m) => m.sessionHost)
  if (list.partial)
    return `${plural(hosts.length, 'machine')} can run sessions. The other machines couldn’t be read.`
  const countOn = (items: readonly Machine[]) =>
    items.filter((m) => m.up === 'on').length
  const all = `${plural(total, 'machine')}, ${countOn(list.machines)} on.`
  if (list.hostsUnknown)
    return `${all} Sessions can run on some of them (the session hosts couldn’t be checked).`
  const on = countOn(hosts)
  const state =
    on === hosts.length
      ? `${hosts.length === 1 ? 'it is' : 'all of those are'} on`
      : on === 0
        ? 'none of those are on'
        : `${on} of those ${on === 1 ? 'is' : 'are'} on`
  return `${all} Sessions can run on ${hosts.length} of them; ${state}.`
}
