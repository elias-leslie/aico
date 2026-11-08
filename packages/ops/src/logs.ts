// `aico logs UNIT|PROJECT [-n N] [--since T] [-l LEVEL] [-f]`: a unit's journal (the user manager's,
// else the system's), or every unit of a project from its project.identity.json, on the machine it runs on.

import type { Project } from './deploy'
import { canonical, loadProject } from './deploy'
import type { Runner } from './sh'

// One level only, as `st logs -l` shows it: journal priorities grouped the way st names them.
const LEVELS: Record<string, string> = {
  CRITICAL: 'emerg..crit',
  ERROR: 'err..err',
  WARN: 'warning..warning',
  WARNING: 'warning..warning',
  INFO: 'notice..info',
  DEBUG: 'debug..debug',
}

export interface LogsRequest {
  target: string
  lines: number
  since?: string
  level?: string
  follow: boolean
}

export function parseLogsArgs(argv: string[]): LogsRequest | string {
  const req: LogsRequest = { target: '', lines: 100, follow: false }
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i] as string
    const next = () => {
      const value = argv[++i]
      if (value === undefined) throw new Error(`${arg} needs a value`)
      return value
    }
    if (arg === '-n' || arg === '--lines') req.lines = Number(next())
    else if (arg === '--since') req.since = next()
    else if (arg === '-l' || arg === '--level') req.level = next()
    else if (arg === '-f' || arg === '--follow') req.follow = true
    else if (arg === '-s' || arg === '--service') req.target = next()
    else if (arg.startsWith('-')) return `unknown option ${arg}`
    else if (req.target) return `one unit or project only (got ${req.target} and ${arg})`
    else req.target = arg
  }
  if (!req.target) return 'name a unit (aico logs tether@default) or a project (aico logs aico)'
  if (!Number.isInteger(req.lines) || req.lines < 1) return '-n needs a positive number'
  if (req.level && !LEVELS[req.level.toUpperCase()])
    return `level must be one of ${Object.keys(LEVELS).join(', ')}`
  return req
}

const projectUnits = (project: Project) =>
  [
    project.backend,
    ...project.defaultWorkers,
    ...project.optionalWorkers,
    ...project.manualWorkers,
  ].filter(Boolean)

/** The journalctl argv for a request; units of the project when the target names it; null for no such unit. */
export function journalArgs(req: LogsRequest, project: Project, run: Runner): string[] | null {
  const units = project.names.includes(req.target) ? projectUnits(project) : [canonical(req.target)]
  let user = units.length > 1
  if (!user) {
    user = run('systemctl', ['--user', 'cat', units[0] as string]).code === 0
    if (!user && run('systemctl', ['cat', units[0] as string]).code !== 0) {
      // Collected transient units (deploy jobs) and removed services can still have a journal.
      const retained = (userJournal: boolean) => {
        const result = run('journalctl', [
          ...(userJournal ? ['--user'] : []),
          '--quiet',
          '--no-pager',
          '-n',
          '1',
          '-o',
          'json',
          '-u',
          units[0] as string,
        ])
        return result.code === 0 && result.out.trim().length > 0
      }
      user = retained(true)
      if (!user && !retained(false)) return null
    }
  }
  return tailArgs(req, units, user)
}

function tailArgs(req: LogsRequest, units: string[], user: boolean): string[] {
  const args = [
    ...(user ? ['--user'] : []),
    ...units.flatMap((unit) => ['-u', unit]),
    '-n',
    String(req.lines),
    '--no-pager',
  ]
  if (req.since) args.push('--since', /^\d+[smhd]$/.test(req.since) ? `-${req.since}` : req.since)
  if (req.level) args.push('-p', LEVELS[req.level.toUpperCase()] as string)
  if (req.follow) args.push('-f')
  return args
}

/** One word for a remote shell, which ssh hands its arguments to joined. */
const shellWord = (word: string) =>
  /^[\w@%+=:,./-]+$/.test(word) ? word : `'${word.replaceAll("'", `'\\''`)}'`

/** The command that reads another registered project's journal, where it runs: over its runtime's
 * `ssh`, or into its container from the Proxmox host, under the manager it declares. Null when the
 * target is no such project; a string says why there is nothing to read. */
export function otherProjectLogs(
  req: LogsRequest,
  run: Runner,
): { cmd: string; args: string[] } | string | null {
  const shown = run('aico', ['projects', 'show', req.target, '--json'])
  if (shown.code !== 0) return null
  const registered = JSON.parse(shown.out) as {
    id: string
    root_path?: string | null
    runtime?: { ssh?: string }[]
  }
  if (!registered.root_path) return `${registered.id} has no folder, so its units are unknown`
  let project: Project
  try {
    project = loadProject(registered.root_path)
  } catch {
    return `${registered.id} is registered but has no project.identity.json, so its units are unknown`
  }
  const units = projectUnits(project)
  if (!units.length) return `${registered.id} has no services to read logs from`
  const placed = project.deployment
  const args = tailArgs(req, units, placed?.manager !== 'system')
  const host = registered.runtime?.find((place) => place.ssh)?.ssh
  if (host) return { cmd: 'ssh', args: [host, 'journalctl', ...args].map(shellWord) }
  if (!placed) return { cmd: 'journalctl', args }
  if (placed.guest_type !== 'lxc')
    return `${registered.id} runs on VM ${placed.vmid}, which has no ssh address here: aico projects runtime ${registered.id} can name one`
  const asUser =
    placed.manager === 'system'
      ? []
      : ['runuser', '-u', placed.user ?? '', '--', 'env', `XDG_RUNTIME_DIR=/run/user/${placed.uid}`]
  const inGuest = ['pct', 'exec', String(placed.vmid), '--', ...asUser, 'journalctl', ...args]
  return { cmd: 'ssh', args: [placed.ssh_host, ...inGuest.map(shellWord)] }
}

/** Where Status says a job's log is, for a target that is a Status row and no unit. */
export function statusPointer(target: string, run: Runner): string | null {
  const found = run('aico', ['status', '--search', target, '--json'])
  if (found.code !== 0) return null
  let rows: {
    id?: string
    what?: string
    project?: string
    actions?: { kind?: string; ref?: string }[]
  }[]
  try {
    rows = (JSON.parse(found.out) as { rows?: typeof rows }).rows ?? []
  } catch {
    return null
  }
  const wanted = target.toLowerCase()
  const row = rows.find(
    (r) => r.what?.toLowerCase() === wanted || r.id?.toLowerCase().endsWith(`/${wanted}`),
  )
  if (!row) return null
  const log = row.actions?.find((action) => action.kind === 'log')?.ref
  if (log) return `${row.what}: ${log}`
  return row.project ? `${row.what} is a job of ${row.project}: aico logs ${row.project}` : null
}
