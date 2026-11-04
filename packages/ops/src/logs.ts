// `aico logs UNIT|PROJECT [-n N] [--since T] [-l LEVEL] [-f]`: a unit's journal (the user manager's,
// else the system's), or every unit of a project from its project.identity.json.

import type { Project } from './deploy'
import { canonical } from './deploy'
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

/** The journalctl argv for a request; units of the project when the target names it; null for no such unit. */
export function journalArgs(req: LogsRequest, project: Project, run: Runner): string[] | null {
  const units = project.names.includes(req.target)
    ? [
        project.backend,
        ...project.defaultWorkers,
        ...project.optionalWorkers,
        ...project.manualWorkers,
      ].filter(Boolean)
    : [canonical(req.target)]
  let user = units.length > 1
  if (!user) {
    user = run('systemctl', ['--user', 'cat', units[0] as string]).code === 0
    if (!user && run('systemctl', ['cat', units[0] as string]).code !== 0) return null
  }
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
