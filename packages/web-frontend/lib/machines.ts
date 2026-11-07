// The Machines page's data: every machine once, from the Status machine rows and the hosts
// sessions can run on (Tether's links). Pure; the page fetches and renders.

import type { HostChoice } from './hooks/use-hosts'
import { MACHINE_LABEL, WORKSTATION_LABEL } from './machine-name'
import {
  ago,
  at,
  plural,
  reason,
  type StatusRow,
  type StatusView,
} from './status'

/** The session host that is this computer: `New session` and the hosts list name it only by omission. */

/** Session hosts whose Tether name is not the machine's own name (data, from the Tether hosts
 * file: the `aico` link reaches the Proxmox host over ssh). */
const SESSION_HOST_MACHINE: Record<string, string> = {
  aico: 'davion-gem',
}

/** What a machine is for, where Aico's data does not already say. */
const PURPOSE: Record<string, string> = {
  'davion-sidarli': 'Runs Aico, your agents and their projects.',
  'davion-gem': 'Runs the VMs and containers. Its watchdog reports to Aico.',
  'neri-hunters': 'The security hunt.',
  'ominull-hub': 'Detection and paging (OmniNull).',
  apps: 'Portfolio and other apps.',
  jobinator: 'Job scans and screening (Jobinator).',
}
const SESSION_HOST_PURPOSE = 'Runs sessions away from the workstation.'

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
  /** The one power action offered, if any. */
  power: 'on' | 'off' | 'trust' | null
  isWorkstation: boolean
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
    return since ? `Off since ${at(since, now)}.` : ''
  }
  if (row && !isLink(row))
    return `Reported ${ago(Date.parse(row.updated_at), now)}.`
  return ''
}

/** Every machine once. `view` is null while Status can't be read, `hosts` null while the hosts can't. */
export function buildMachines(
  view: StatusView | null,
  hosts: HostChoice[] | null,
  now: number,
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
    const sessionHost = isWorkstation || !!host || (!!link && hosts === null)
    const sessionHostName = host?.name ?? null
    const note = noteFor(up, row ?? link, host, now)
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

/** "8 machines; 4 can run sessions", from the list as shown. */
export function machinesLine(list: Machines): string {
  const total = list.machines.length
  const hosts = list.machines.filter((m) => m.sessionHost).length
  if (list.partial)
    return `${plural(hosts, 'machine')} can run sessions. The other machines couldn’t be read.`
  return `${plural(total, 'machine')}; ${hosts} can run sessions${list.hostsUnknown ? ' (the session hosts couldn’t be checked)' : ''}.`
}
