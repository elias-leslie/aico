// `st status`: this machine's Status rows from aico-web (GET /api/status), problems
// first with what each means and what to do, healthy rows folded into a count.

import type { ShownRow, StatusView } from '@aico/status'

const STATUS_USAGE = `Usage: st status [options]

Shows every check, job, backup, service, VM and machine that reports to Aico on this
machine: problems first (failed, late, unknown, warn), healthy rows folded into a count.

Options:
  --state S[,S]     failed, late, unknown, warn, ok, off
  --kind K[,K]      check, job, backup, service, vm, machine, link, grant, repo
  --machine M[,M]   only these machines
  --project P[,P]   only these projects
  --search TEXT     text in the name, meaning, id, machine or project
  --sort ORDER      problems (default), what, updated, next
  --all             list the healthy rows too
  --json            the API answer as JSON
`

const FILTERS: Readonly<Record<string, string>> = {
  '--state': 'state',
  '--kind': 'kind',
  '--machine': 'machine',
  '--project': 'project',
  '--search': 'q',
  '--sort': 'sort',
}

export interface StatusCliIo {
  out(text: string): void
  err(text: string): void
  /** aico-web's base URL on loopback. */
  baseUrl: string
  fetch: typeof fetch
  now(): number
}

const LABELS: Record<ShownRow['shown'], string> = {
  failed: 'Failed',
  late: 'Late',
  unknown: 'Unknown',
  warn: 'Warning',
  ok: 'OK',
  off: 'Off',
}

const ACTION_LABELS: Record<string, string> = {
  run: 'Run now',
  log: 'Log',
  detail: 'Detail',
  look: 'Look into it',
}

const pad = (value: number) => String(value).padStart(2, '0')

/** A time in local words: "today 03:30", "yesterday 22:10", "tomorrow 04:30", else "Nov 1 14:00". */
export function when(iso: string, now: number): string {
  const at = new Date(iso)
  const clock = `${pad(at.getHours())}:${pad(at.getMinutes())}`
  const day = (date: Date) =>
    new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime()
  const days = Math.round((day(at) - day(new Date(now))) / 86_400_000)
  if (days === 0) return `today ${clock}`
  if (days === -1) return `yesterday ${clock}`
  if (days === 1) return `tomorrow ${clock}`
  const month = at.toLocaleString('en-US', { month: 'short' })
  return `${month} ${at.getDate()} ${clock}`
}

function rowLines(row: ShownRow, now: number): string[] {
  const where = [row.kind, row.machine, row.project].filter(Boolean).join(', ')
  let head = `${LABELS[row.shown].padEnd(8)} ${row.what} (${where})`
  if (row.shown === 'late' && row.shown_since) head += `, late since ${when(row.shown_since, now)}`
  if (row.shown === 'unknown')
    head += row.shown_since
      ? `, no word from ${row.machine} since ${when(row.shown_since, now)}`
      : `, no word from ${row.machine}`
  const indent = ' '.repeat(9)
  const lines = [head]
  const said =
    row.shown === row.state
      ? row.meaning
      : `Last report: ${LABELS[row.state].toLowerCase()}. ${row.meaning}`
  lines.push(`${indent}${said}`)
  const times = [
    row.last_run && `Last run ${when(row.last_run, now)}.`,
    row.next_run && `Next due ${when(row.next_run, now)}.`,
  ].filter(Boolean)
  if (times.length) lines.push(`${indent}${times.join(' ')}`)
  for (const action of row.actions ?? [])
    lines.push(`${indent}${ACTION_LABELS[action.kind] ?? action.kind}: ${action.ref}`)
  return lines
}

function plural(count: number, word: string): string {
  return `${count} ${word}${count === 1 ? '' : 's'}`
}

/** The text `st status` prints for an API answer. */
export function formatStatus(
  view: StatusView,
  all: boolean,
  now: number,
  filtered = false,
): string {
  const { rollup, rows } = view
  if (rows.length === 0)
    return filtered
      ? 'No status rows match.\n'
      : 'No status rows yet: they appear as checks, jobs and services report in.\n'
  const healthyParts = (['ok', 'off'] as const)
    .filter((state) => rollup.counts[state] > 0)
    .map((state) => `${rollup.counts[state]} ${state}`)
    .join(', ')
  const out: string[] = []
  out.push(
    rollup.problems === 0
      ? `No problems: ${plural(rollup.healthy, 'row')} healthy (${healthyParts}).`
      : `${plural(rollup.problems, 'problem')}, ${rollup.healthy} healthy.`,
  )
  const shown = all ? rows : rows.filter((row) => row.shown !== 'ok' && row.shown !== 'off')
  for (const row of shown) out.push('', ...rowLines(row, now))
  if (!all && rollup.healthy > 0 && rollup.problems > 0)
    out.push('', `${rollup.healthy} healthy (${healthyParts}) not listed; --all lists them.`)
  return `${out.join('\n')}\n`
}

export async function runStatusCli(argv: string[], io: StatusCliIo): Promise<number> {
  const query = new URLSearchParams()
  let all = false
  let json = false
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index] as string
    if (arg === '--help' || arg === '-h') {
      io.out(STATUS_USAGE)
      return 0
    }
    if (arg === '--all') all = true
    else if (arg === '--json') json = true
    else if (FILTERS[arg] && argv[index + 1] !== undefined) {
      query.set(FILTERS[arg] as string, argv[index + 1] as string)
      index += 1
    } else {
      io.err(`st status: unknown or incomplete option '${arg}'\n\n${STATUS_USAGE}`)
      return 2
    }
  }
  const url = `${io.baseUrl}/api/status${query.size ? `?${query}` : ''}`
  let response: Response
  try {
    response = await io.fetch(url, { signal: AbortSignal.timeout(10_000) })
  } catch {
    io.err(
      `Aico isn't answering at ${io.baseUrl}, so there are no rows to show.\nStart it: systemctl --user start aico-web.service\n`,
    )
    return 69
  }
  const body = (await response.json().catch(() => null)) as StatusView | { detail?: string } | null
  if (!response.ok || !body || !('rows' in body)) {
    const detail = body && 'detail' in body && body.detail ? body.detail : `HTTP ${response.status}`
    io.err(`st status: ${detail}\n`)
    return response.status === 422 ? 2 : 1
  }
  io.out(
    json ? `${JSON.stringify(body, null, 2)}\n` : formatStatus(body, all, io.now(), query.size > 0),
  )
  return 0
}
