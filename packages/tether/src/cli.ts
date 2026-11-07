import { spawnSync } from 'node:child_process'
import { isAbsolute, resolve } from 'node:path'
import { runFleet } from '@aico/fleet/hub/fleet-cli'
import { runLogins } from '@aico/fleet/logins-cli'
import { Store } from '@aico/session-engine/store'
import { nearest } from '@aico/shared/suggest'
import { localTime } from '@aico/shared/time'
import { ASK_USAGE, runAsk } from './ask-cli'
import { CAPTURE_USAGE, runCapture } from './capture-cli'
import { callSocket } from './client'
import { resolvePaths, type TetherPaths } from './config'
import { startDaemon } from './daemon'
import { runDoctor } from './doctor'
import { fleetCliPorts } from './hub/ports'
import { applyImport, formatPlan, planImportForPath, summarize } from './importer'
import { NOTE_USAGE, runNote } from './note-cli'
import { withOwnWidget } from './own-session'
import { HISTORY_USAGE, runHistory } from './sessions/cli'
import { VERSION } from './version'

const USAGE = `Usage: tether [--instance NAME] [--json] <command>

Commands:
  serve                         run the daemon (used by tether@<instance>.service)
  doctor                        check host prerequisites and the running daemon
  version                       print the CLI and daemon versions
  sessions [list | get <id>]    live sessions, one per line (ID, STATUS, STATE, TOOL, PROJECT, NAME);
                                get: one session (--json: the whole record)
  sessions create [--tool T] [--project P] [--name N] [--continue-from ID]
                                start a session (alias: new); one line about it; --json prints
                                the whole record. --continue-from ID (with --tool): carry on from
                                that session in another tool, in its checkout, starting from a
                                recap (its first request, its last messages, git status)
  reboot prepare [--timeout SEC] [--no-notify]   ask agents to checkpoint; exit 0 ready, 3 not
  reboot status                 restore results since the last boot
  recovery status               crash recoveries: waiting, recovered or held
  recovery resume <id> [--mem-bytes N --cpus N]  resume a session that was cut short; give both
                                numbers to set the memory and CPUs it needs
  sessions end <id>             end one session
  sessions attach <id> [--print]
                                attach this terminal (exec tmux); --print shows
                                the argv. Inside another tmux server the client
                                nests with TMUX unset; inside the same server
                                it switches the current client.
  sessions diagnostics <id>
  roots [list | show <requestId>]   coordinator sessions started from a request
  share <path>... [--title T] [--session ID]
                                show the owner files or folders where they are
                                (Aico: Files > Shared; nothing is copied);
                                relative paths are from here; the session is
                                this pane's own unless --session ID names one
  share --url <url> [--title T] [--session ID]
  share remove <id>...          take entries out of Files > Shared (a file named
                                "remove" is ./remove); an unknown id exits 1,
                                the rest are still removed
  ask create|get|list|done|withdraw
                                put a question to the owner in Aico and read
                                the answer (tether ask --help)
  history list|show|events      recent sessions of Claude Code, Codex and Pi and what
                                they said and did (aico recent ...; tether history --help)
  capture list|get|file         read the owner's photos and files saved in Aico
                                (tether capture --help)
  note list|get|add|item|groceries
                                read and add to the owner's notes and Groceries
                                list in Aico (tether note --help)
  import-aico --from PATH [--apply]
                                copy a pre-Tether Aico catalog (an archived
                                aico.db; dry-run unless --apply; opened
                                read-only; stop the daemon first)
  tools [list]                  the tools a new session can start (claude-code, codex, ...)
  tools get <slug>
  tools add <slug> <name> -- <argv...>
  tools default|enable|disable <slug>
  tools rm <slug>
  projects [--refresh]          project list (registry, else local)
  hosts                         other machines this one is linked to, with link state
  fleet identity ROLE           show this machine's public key and join code (full|worker)
  fleet enroll PUBLIC_FILE      ask the owner to let another machine join
  fleet approve FILE ASK PINS   admin only: record the machine the owner approved in Needs you
  fleet exec SOCKET -- COMMAND  run a command on a machine that has joined

The instance defaults to $TETHER_INSTANCE or "default". tether COMMAND --help shows one command.`

/** The usage lines of one command, or of one command and subcommand ("sessions create"). */
function commandUsage(command: string, sub?: string): string {
  const pick = (prefix: string) => {
    const lines: string[] = []
    let mine = false
    for (const line of USAGE.split('\n')) {
      if (/^ {2}\S/.test(line)) mine = line.startsWith(prefix)
      else if (!/^ {3,}/.test(line)) mine = false
      if (mine) lines.push(line)
    }
    return lines
  }
  const one = sub ? pick(`  ${command} ${sub}`) : []
  const found = one.length ? one : pick(`  ${command}`)
  return found.length
    ? `Usage: tether [--instance NAME] [--json] <command>\n\n${found.join('\n')}`
    : USAGE
}

/** Commands with a usage text of their own. */
const OWN_USAGE: Record<string, string> = {
  ask: ASK_USAGE,
  history: HISTORY_USAGE,
  capture: CAPTURE_USAGE,
  note: NOTE_USAGE,
}

/** What the agent in a session is doing, in Aico's words; null when it does not say. */
function stateWord(state: unknown): string | null {
  if (state === 'blocked') return 'needs you'
  return state === 'working' || state === 'idle' ? state : null
}

/** The one-line account of a session for a person; --json gives the record. */
export function sessionLine(session: Record<string, unknown>): string {
  const where = session.projectId ? `in ${session.projectId}` : 'in no project'
  const host = session.host ? ` on ${session.host}` : ''
  const known = stateWord(session.state)
  const state = known && known !== session.status ? ` (${known})` : ''
  return `${session.id}  ${session.label ?? session.name ?? ''}  ${session.tool} ${where}${host}, ${session.status}${state}`
}

/** `tether sessions` for a person: a header, one row per session, and what STATUS and STATE mean. */
export function sessionTable(items: Record<string, unknown>[]): string[] {
  const cell = (value: unknown, width: number) => String(value ?? '-').padEnd(width)
  return [
    `${cell('ID', 10)}${cell('STATUS', 10)}${cell('STATE', 11)}${cell('TOOL', 13)}${cell('PROJECT', 14)}NAME`,
    ...items.map((item) =>
      `${cell(item.id, 10)}${cell(item.status, 10)}${cell(stateWord(item.state), 11)}${cell(item.tool, 13)}${cell(item.projectId, 14)}${item.label ?? item.name ?? ''}`.trimEnd(),
    ),
    'STATUS is the session (running or ended). STATE is the agent in it: working, idle, needs you, or - when it does not say.',
  ]
}

export interface Io {
  out(text: string): void
  err(text: string): void
}

const consoleIo: Io = {
  out: (text) => process.stdout.write(`${text}\n`),
  err: (text) => process.stderr.write(`${text}\n`),
}

interface Parsed {
  instance?: string
  json: boolean
  args: string[]
}

export function parseArgs(argv: string[]): Parsed {
  const parsed: Parsed = { json: false, args: [] }
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index] as string
    if (arg === '--') {
      parsed.args.push(...argv.slice(index))
      break
    }
    if (arg === '--json') parsed.json = true
    else if (arg === '--instance' || arg === '-i') {
      const value = argv[index + 1]
      if (value === undefined) throw new Error('--instance needs a value')
      parsed.instance = value
      index += 1
    } else if (arg.startsWith('--instance=')) parsed.instance = arg.slice('--instance='.length)
    else parsed.args.push(arg)
  }
  return parsed
}

export function render(
  io: Io,
  json: boolean,
  status: number,
  body: unknown,
  empty = 'Nothing here.',
): number {
  if (json || typeof body !== 'object' || body === null) {
    io.out(typeof body === 'string' ? body : JSON.stringify(body, null, 2))
  } else {
    const record = body as Record<string, unknown>
    if (status >= 400) {
      io.err(`error ${status}: ${record.error}${record.detail ? ` — ${record.detail}` : ''}`)
    } else if (Array.isArray(record.items) && record.items.length === 0) {
      io.out(empty)
    } else if (
      Array.isArray(record.items) &&
      (record.items as Record<string, unknown>[]).some((item) => 'generation' in item)
    ) {
      for (const row of sessionTable(record.items as Record<string, unknown>[])) io.out(row)
    } else if (
      Array.isArray(record.items) &&
      (record.items as Record<string, unknown>[]).some((item) => 'ssh' in item)
    ) {
      // GET /v1/hosts: name, link state, sessions and the last update (versions are in --json).
      const items = record.items as Record<string, unknown>[]
      io.out(`${'HOST'.padEnd(16)} ${'LINK'.padEnd(12)} ${'SESSIONS'.padEnd(9)} UPDATE`)
      for (const item of items) {
        const update = item.update as Record<string, unknown> | null
        const updated = update
          ? `${update.state ?? ''}${update.error ? `: ${update.error}` : ''}`
          : '-'
        io.out(
          `${String(item.name).padEnd(16)} ${String(item.state).padEnd(12)} ${String(item.sessions).padEnd(9)} ${updated}`,
        )
      }
    } else if (Array.isArray(record.items)) {
      for (const item of record.items as Record<string, unknown>[]) {
        const marker = item.isDefault ? '*' : ' '
        const state = item.enabled === false ? ' (disabled)' : ''
        io.out(`${marker} ${String(item.slug).padEnd(14)} ${item.command || '(shell)'}${state}`)
      }
    } else if (Array.isArray(record.projects)) {
      io.out(`source: ${record.source}`)
      for (const project of record.projects as Record<string, unknown>[]) {
        io.out(`  ${String(project.id).padEnd(24)} ${project.root}`)
      }
    } else {
      io.out(JSON.stringify(body, null, 2))
    }
  }
  return status >= 200 && status < 300 ? 0 : 1
}

async function api(
  io: Io,
  paths: TetherPaths,
  json: boolean,
  method: string,
  path: string,
  body?: unknown,
  empty?: string,
): Promise<number> {
  try {
    const response = await callSocket(paths.socket, method, path, body)
    return render(io, json, response.status, response.body, empty)
  } catch (error) {
    io.err(
      `tether (${paths.instance}) is not reachable at ${paths.socket}: ${(error as Error).message}`,
    )
    return 2
  }
}

/**
 * The `/v1/show` body for `tether share`. Its session is the pane's own Aico
 * session (`AICO_WIDGET_ID`, `<id>` or `aico-widget-<id>`) unless `--session` names one.
 */
export function shareBody(
  args: string[],
  env: NodeJS.ProcessEnv,
  cwd: string,
): Record<string, unknown> | string {
  const files: string[] = []
  let title: string | undefined
  let url: string | undefined
  let session = /^(?:aico-widget-)?([0-9a-f]{8})$/.exec(env.AICO_WIDGET_ID ?? '')?.[1]
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index] as string
    const option = /^--(title|url|session)(?:=(.*))?$/.exec(arg)
    if (!option) {
      files.push(isAbsolute(arg) ? arg : resolve(cwd, arg))
      continue
    }
    if (option[2] === undefined) index += 1
    const value = option[2] ?? args[index]
    if (value === undefined) return `--${option[1]} needs a value`
    if (option[1] === 'title') title = value
    else if (option[1] === 'url') url = value
    else session = value
  }
  if ((url === undefined) === (files.length === 0)) return 'give files to share, or --url'
  return {
    ...(session ? { session } : {}),
    ...(title === undefined ? {} : { title }),
    ...(url === undefined ? { paths: files } : { url }),
  }
}

/** `tether share remove ID...`: each entry goes; exit 1 if any ID was unknown. */
async function runShareRemove(
  io: Io,
  json: boolean,
  socket: string,
  ids: string[],
): Promise<number> {
  if (!ids.length) {
    io.err('tether share remove: give the ID of each entry to remove')
    return 2
  }
  const results: { id: string; removed: boolean }[] = []
  for (const id of ids) {
    const response = await callSocket(socket, 'DELETE', `/v1/shares/${encodeURIComponent(id)}`)
    if (response.status !== 200 && response.status !== 404) {
      return render(io, json, response.status, response.body)
    }
    results.push({ id, removed: response.status === 200 })
  }
  const missing = results.filter((result) => !result.removed)
  if (json) io.out(JSON.stringify({ results }))
  else {
    for (const { id, removed } of results) io.out(removed ? `Removed ${id}` : `No share ${id}`)
  }
  if (missing.length) {
    io.err(`tether share remove: no such share: ${missing.map((result) => result.id).join(', ')}`)
    return 1
  }
  return 0
}

/**
 * `--json version`: one JSON object on stdout and nothing else. The daemon's
 * `/v1/version` fields stay at the top level (`apiVersion`, ...) next to `cli`;
 * with no daemon, `daemon` is null and the reason goes to stderr (exit 2).
 */
async function jsonVersion(io: Io, paths: TetherPaths): Promise<number> {
  try {
    const response = await callSocket(paths.socket, 'GET', '/v1/version')
    const body =
      typeof response.body === 'object' && response.body !== null
        ? (response.body as Record<string, unknown>)
        : { daemon: response.body }
    io.out(JSON.stringify({ cli: VERSION, ...body }, null, 2))
    return response.status >= 200 && response.status < 300 ? 0 : 1
  } catch (error) {
    io.out(JSON.stringify({ cli: VERSION, daemon: null, error: 'not_reachable' }, null, 2))
    io.err(
      `tether (${paths.instance}) is not reachable at ${paths.socket}: ${(error as Error).message}`,
    )
    return 2
  }
}

/** `--name value` / `--name=value` pairs; unknown flags are rejected. */
function flags(args: string[], names: string[]): Record<string, string> {
  const out: Record<string, string> = {}
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index] as string
    if (arg === '--apply') continue
    const [name, inline] = arg.split(/=(.*)/s, 2) as [string, string | undefined]
    if (!names.includes(name)) throw new Error(`unknown option ${name}`)
    let value = inline
    if (value === undefined) {
      index += 1
      value = args[index]
    }
    if (value === undefined) throw new Error(`${name} needs a value`)
    out[name] = value
  }
  return out
}

export interface AttachPlan {
  argv: string[]
  env: Record<string, string>
  notice?: string
}

/** How to attach this terminal: the daemon's argv with its env overrides
 * applied over ours and its unset list removed. Inside a client of the same
 * tmux server, switch that client instead of nesting a second one; inside a
 * different server, nest with TMUX unset and say so. */
export function attachPlan(
  response: { argv: string[]; env?: Record<string, string>; unset?: string[] },
  current: NodeJS.ProcessEnv,
): AttachPlan {
  const env: Record<string, string> = {}
  for (const [key, value] of Object.entries(current)) if (value !== undefined) env[key] = value
  Object.assign(env, response.env ?? {})
  for (const key of response.unset ?? []) delete env[key]
  const argv = [...response.argv]
  const outer = current.TMUX?.split(',')[0]
  if (!outer) return { argv, env }
  const socketIndex = argv.indexOf('-S')
  const socket = socketIndex >= 0 ? argv[socketIndex + 1] : undefined
  if (socket && socket === outer) {
    const command = argv.indexOf('attach-session')
    if (command >= 0) {
      argv[command] = 'switch-client'
      env.TMUX = current.TMUX as string
      return { argv, env }
    }
  }
  return {
    argv,
    env,
    notice: `tether: nesting inside the current tmux (${outer}); detach with the inner prefix`,
  }
}

/** A refused session call for a person: an unknown id says so, naming the id. */
function sessionRefusal(
  io: Io,
  json: boolean,
  id: string,
  response: { status: number; body: unknown },
): number {
  if (!json && response.status === 404) {
    io.err(`No session ${id} (ended or never existed); tether sessions list shows the live ones`)
    return 1
  }
  return render(io, json, response.status, response.body)
}

function slugPath(slug: string | undefined): string {
  if (!slug) throw new Error('a tool slug is required')
  return `/v1/tools/${encodeURIComponent(slug)}`
}

export async function main(argv: string[], io: Io = consoleIo): Promise<number> {
  let parsed: Parsed
  try {
    parsed = parseArgs(argv)
  } catch (error) {
    io.err((error as Error).message)
    return 2
  }
  const [command, sub, ...rest] = parsed.args
  if (!command || command === 'help' || command === '--help' || command === '-h') {
    io.out(USAGE)
    return command ? 0 : 2
  }
  let paths: TetherPaths
  try {
    paths = resolvePaths({ instance: parsed.instance })
  } catch (error) {
    io.err((error as Error).message)
    return 2
  }
  const { json } = parsed
  const words = parsed.args.slice(1)
  const end = words.indexOf('--')
  if ((end < 0 ? words : words.slice(0, end)).some((w) => w === '--help' || w === '-h')) {
    if (command === 'logins') return runLogins(['--help'])
    if (command === 'fleet') return runFleet(['--help'], paths, io, fleetCliPorts(paths))
    io.out(OWN_USAGE[command] ?? commandUsage(command, sub))
    return 0
  }
  try {
    switch (command) {
      case 'serve': {
        const daemon = await startDaemon(paths)
        await new Promise<void>((resolve) => {
          for (const signal of ['SIGTERM', 'SIGINT'] as const) process.once(signal, () => resolve())
        })
        await daemon.close()
        return 0
      }
      case 'doctor': {
        const checks = await runDoctor(paths)
        if (json) io.out(JSON.stringify(checks, null, 2))
        else
          for (const check of checks)
            io.out(`${check.status.padEnd(4)} ${check.name}: ${check.detail}`)
        return checks.some((check) => check.status === 'fail') ? 1 : 0
      }
      case 'version':
        if (json) return jsonVersion(io, paths)
        io.out(`tether ${VERSION}`)
        return api(io, paths, json, 'GET', '/v1/version')
      case 'sessions':
        if (!sub || sub === 'list')
          return api(
            io,
            paths,
            json,
            'GET',
            '/v1/sessions',
            undefined,
            'No live sessions. Start one: tether sessions create',
          )
        if (sub === 'get' && rest[0] && json) {
          const found = await callSocket(
            paths.socket,
            'GET',
            `/v1/sessions/${encodeURIComponent(rest[0])}`,
          )
          return render(io, json, found.status, found.body)
        }
        if (sub === 'diagnostics' && rest[0]) {
          const found = await callSocket(
            paths.socket,
            'GET',
            `/v1/sessions/${encodeURIComponent(rest[0])}/diagnostics`,
          )
          return sessionRefusal(io, json, rest[0], found)
        }
        if (sub === 'attach' && rest[0]) {
          const path = `/v1/sessions/${encodeURIComponent(rest[0])}/attach`
          if (json || rest.includes('--print')) return api(io, paths, json, 'GET', path)
          const response = await callSocket(paths.socket, 'GET', path, undefined, 15_000)
          if (response.status !== 200) return sessionRefusal(io, json, rest[0], response)
          const plan = attachPlan(response.body as Parameters<typeof attachPlan>[0], process.env)
          if (plan.notice) io.err(plan.notice)
          const [file, ...args] = plan.argv as [string, ...string[]]
          const child = spawnSync(file, args, { stdio: 'inherit', env: plan.env })
          if (child.error) {
            io.err(`tether: ${child.error.message}`)
            return 2
          }
          return child.status ?? 1
        }
        if (sub === 'new' || sub === 'create') {
          const options = flags(rest, ['--tool', '--project', '--name', '--continue-from'])
          const body: Record<string, unknown> = {
            origin: 'cli',
            size: { cols: process.stdout.columns || 120, rows: process.stdout.rows || 40 },
          }
          if (options['--tool']) body.tool = options['--tool']
          if (options['--project']) body.projectId = options['--project']
          if (options['--name']) body.name = options['--name']
          if (options['--continue-from']) body.continueFrom = options['--continue-from']
          const created = await callSocket(paths.socket, 'POST', '/v1/sessions', body, 60_000)
          const session = created.body as Record<string, unknown> | null
          if (json || created.status >= 300 || typeof session?.id !== 'string')
            return render(io, json, created.status, created.body)
          io.out(`Created ${sessionLine(session)}`)
          io.out(
            `Attach here: tether sessions attach ${session.id}   End it: tether sessions end ${session.id}`,
          )
          return 0
        }
        if (sub === 'get' && rest[0] && !json) {
          const found = await callSocket(
            paths.socket,
            'GET',
            `/v1/sessions/${encodeURIComponent(rest[0])}`,
          )
          const session = found.body as Record<string, unknown> | null
          if (found.status !== 200 || typeof session?.id !== 'string')
            return sessionRefusal(io, json, rest[0], found)
          io.out(sessionLine(session))
          io.out(
            `  root ${session.projectRoot ?? '-'}; started ${session.createdAt ? localTime(Number(session.createdAt)) : '-'}`,
          )
          io.out('  Every field: add --json')
          return 0
        }
        if (sub === 'show') {
          io.err(
            'tether sessions show is gone: Aico has no windows. Open the session in Aico, or attach this terminal: tether sessions attach ID',
          )
          return 2
        }
        if (sub === 'end' && rest[0]) {
          const path = `/v1/sessions/${encodeURIComponent(rest[0])}`
          const current = await callSocket(paths.socket, 'GET', path, undefined, 15_000)
          const generation = (current.body as Record<string, unknown> | null)?.generation
          if (current.status !== 200 || typeof generation !== 'string')
            return sessionRefusal(io, json, rest[0], current)
          const ended = await callSocket(paths.socket, 'POST', `${path}/end`, { generation })
          if (json || ended.status !== 200) return render(io, json, ended.status, ended.body)
          io.out(`Ended ${rest[0]}.`)
          return 0
        }
        break
      case 'reboot':
        if (sub === 'prepare') {
          const options = flags(
            rest.filter((arg) => arg !== '--no-notify'),
            ['--timeout'],
          )
          const timeoutSec = options['--timeout'] === undefined ? 300 : Number(options['--timeout'])
          if (!Number.isFinite(timeoutSec) || timeoutSec < 0 || timeoutSec > 3600) {
            io.err('tether: --timeout must be 0-3600 seconds')
            return 2
          }
          const body = { timeoutSec, notify: !rest.includes('--no-notify') }
          const response = await callSocket(
            paths.socket,
            'POST',
            '/v1/reboot/prepare',
            body,
            (timeoutSec + 60) * 1000,
          )
          const code = render(io, json, response.status, response.body)
          if (code !== 0) return code
          return (response.body as { ready?: boolean } | null)?.ready ? 0 : 3
        }
        if (sub === 'status') return api(io, paths, json, 'GET', '/v1/reboot/status')
        break
      case 'recovery':
        if (sub === 'status') return api(io, paths, json, 'GET', '/v1/recovery/status')
        if (sub === 'resume' && rest[0]) {
          const options = flags(rest.slice(1), ['--mem-bytes', '--cpus'])
          const memory = options['--mem-bytes']
          const cpus = options['--cpus']
          if (
            (memory === undefined) !== (cpus === undefined) ||
            (memory !== undefined &&
              (!Number.isSafeInteger(Number(memory)) ||
                Number(memory) <= 0 ||
                !Number.isFinite(Number(cpus)) ||
                Number(cpus) <= 0))
          ) {
            io.err('tether: give both --mem-bytes and --cpus as positive numbers')
            return 2
          }
          return api(
            io,
            paths,
            json,
            'POST',
            `/v1/recovery/${encodeURIComponent(rest[0])}/resume`,
            memory === undefined ? {} : { needs: { memBytes: Number(memory), cpu: Number(cpus) } },
          )
        }
        break
      case 'import-aico': {
        const options = flags(
          [sub, ...rest].filter((arg): arg is string => arg !== undefined),
          ['--from'],
        )
        const apply = [sub, ...rest].includes('--apply')
        // Explicit source only: the pre-Tether tables in the live aico.db are
        // being dropped, so an archived copy is the only meaningful input.
        const from = options['--from']
        if (!from) {
          io.err('usage: tether import-aico --from PATH [--apply] (PATH: an archived aico.db)')
          return 2
        }
        if (!apply) {
          const plan = planImportForPath(from, paths.dbPath)
          if (json)
            io.out(
              JSON.stringify(
                { applied: false, summary: summarize(plan), entries: plan.entries },
                null,
                2,
              ),
            )
          else for (const line of formatPlan(plan, false)) io.out(line)
          return 0
        }
        // The daemon is the instance's only writer; never write beside it.
        const live = await callSocket(paths.socket, 'GET', '/v1/health', undefined, 1_000).then(
          () => true,
          () => false,
        )
        if (live) {
          io.err(`tether@${paths.instance} is running; stop it before import-aico --apply`)
          return 1
        }
        const store = new Store(paths.dbPath)
        try {
          const plan = applyImport(from, store)
          if (json)
            io.out(
              JSON.stringify(
                { applied: true, summary: summarize(plan), entries: plan.entries },
                null,
                2,
              ),
            )
          else for (const line of formatPlan(plan, true)) io.out(line)
        } finally {
          store.close()
        }
        return 0
      }
      case 'hosts':
        return api(io, paths, json, 'GET', '/v1/hosts', undefined, 'No other machines are linked.')
      case 'logins':
        return runLogins(parsed.args.slice(1))
      case 'fleet':
        return runFleet([sub ?? '', ...rest], paths, io, fleetCliPorts(paths))
      case 'link':
        io.err(
          'The fleet link runs with the daemon. Use tether fleet identity full|worker to enroll this machine.',
        )
        return 2
      case 'roots':
        if (!sub || sub === 'list') return api(io, paths, json, 'GET', '/v1/roots')
        if (sub === 'show' && rest[0])
          return api(io, paths, json, 'GET', `/v1/roots/${encodeURIComponent(rest[0])}`)
        break
      case 'ask':
        if (sub === undefined || sub === '--help' || sub === 'help') {
          io.out(ASK_USAGE)
          return sub === undefined ? 2 : 0
        }
        return runAsk(
          io,
          paths,
          json,
          parsed.args.slice(1),
          withOwnWidget(process.env),
          process.cwd(),
        )
      case 'history':
        if (sub === '--help' || sub === 'help') {
          io.out(HISTORY_USAGE)
          return 0
        }
        // Bare `history` (or only flags, like --limit 5) lists.
        return runHistory(
          io,
          paths,
          json,
          sub === undefined || sub.startsWith('-')
            ? ['list', ...parsed.args.slice(1)]
            : parsed.args.slice(1),
        )
      case 'capture':
        if (sub === undefined || sub === '--help' || sub === 'help') {
          io.out(CAPTURE_USAGE)
          return sub === undefined ? 2 : 0
        }
        return runCapture(io, json, parsed.args.slice(1))
      case 'note':
        if (sub === undefined || sub === '--help' || sub === 'help') {
          io.out(NOTE_USAGE)
          return sub === undefined ? 2 : 0
        }
        return runNote(io, json, parsed.args.slice(1), withOwnWidget(process.env))
      case 'share': {
        if (sub === 'remove') return runShareRemove(io, json, paths.socket, rest)
        const body = shareBody(parsed.args.slice(1), withOwnWidget(process.env), process.cwd())
        if (typeof body === 'string') {
          io.err(`tether share: ${body}`)
          return 2
        }
        const response = await callSocket(paths.socket, 'POST', '/v1/show', body)
        if (json || response.status !== 201) return render(io, json, response.status, response.body)
        const shared = response.body as { id?: string; paths?: string[] }
        const remove = shared.id ? ` To take it out again: tether share remove ${shared.id}` : ''
        io.out(
          `${
            shared.paths
              ? `Shared ${shared.paths.length === 1 ? '1 path' : `${shared.paths.length} paths`} as links (nothing copied); the owner opens them in Aico under Files > Shared.`
              : 'Shared the link; the owner sees it in Aico.'
          }${remove}`,
        )
        return 0
      }
      case 'tools':
        if (!sub || sub === 'list') return api(io, paths, json, 'GET', '/v1/tools')
        if (sub === 'get') return api(io, paths, json, 'GET', slugPath(rest[0]))
        if (sub === 'rm') return api(io, paths, json, 'DELETE', slugPath(rest[0]))
        if (sub === 'default')
          return api(io, paths, json, 'PATCH', slugPath(rest[0]), { isDefault: true })
        if (sub === 'enable' || sub === 'disable')
          return api(io, paths, json, 'PATCH', slugPath(rest[0]), { enabled: sub === 'enable' })
        if (sub === 'add') {
          const [slug, name, separator, ...toolArgv] = rest
          if (!slug || !name || separator !== '--') {
            io.err('usage: tether tools add <slug> <name> -- <argv...>')
            return 2
          }
          return api(io, paths, json, 'POST', '/v1/tools', { slug, name, argv: toolArgv })
        }
        break
      case 'projects':
        return api(io, paths, json, 'GET', `/v1/projects${sub === '--refresh' ? '?refresh=1' : ''}`)
    }
  } catch (error) {
    const { code, message } = error as NodeJS.ErrnoException
    io.err(
      code === 'ENOENT' || code === 'ECONNREFUSED'
        ? `tether (${paths.instance}) is not reachable at ${paths.socket}: ${message}`
        : message,
    )
    return 2
  }
  io.err(mistake(command, sub))
  return 2
}

/** Subcommands of the commands that have them. */
const SUBCOMMANDS: Record<string, string[]> = {
  sessions: ['list', 'get', 'create', 'new', 'attach', 'end', 'diagnostics'],
  reboot: ['prepare', 'status'],
  recovery: ['status', 'resume'],
  roots: ['list', 'show'],
  tools: ['list', 'get', 'add', 'rm', 'default', 'enable', 'disable'],
}

/** What a subcommand needs when it is named without it. */
const NEEDS: Record<string, string> = {
  'sessions get': 'a session id (tether sessions list shows them)',
  'sessions attach': 'a session id (tether sessions list shows them)',
  'sessions end': 'a session id (tether sessions list shows them)',
  'sessions diagnostics': 'a session id (tether sessions list shows them)',
  'recovery resume': 'a session id (tether recovery status lists them)',
  'roots show': 'a request id (tether roots lists them)',
}

/** The problem with a command line that matched nothing, in one or two lines. */
function mistake(command: string, sub: string | undefined): string {
  const commands = [...USAGE.matchAll(/^ {2}(\S+)/gm)].map((m) => m[1] as string)
  const known = new Set([...commands, ...Object.keys(SUBCOMMANDS), 'link', 'logins'])
  if (!known.has(command)) {
    const near = nearest(command, [...known])
    return `tether: unknown command ${command}${near ? ` (did you mean ${near}?)` : ''}; tether --help lists them`
  }
  const subs = SUBCOMMANDS[command]
  if (subs && sub !== undefined && subs.includes(sub))
    return `tether ${command} ${sub}: needs ${NEEDS[`${command} ${sub}`] ?? 'more arguments'}; tether ${command} ${sub} --help shows how`
  if (subs) {
    const near = sub === undefined ? null : nearest(sub, subs)
    return `tether ${command}: ${sub === undefined ? 'needs a subcommand' : `unknown subcommand ${sub}${near ? ` (did you mean ${near}?)` : ''}`} (${subs.join(', ')}); tether ${command} --help shows how`
  }
  return `tether ${command}: that is not how it is used; tether ${command} --help shows how`
}

const isEntry = process.argv[1] !== undefined && /tether(\.mjs)?$|cli\.ts$/.test(process.argv[1])
if (isEntry) {
  main(process.argv.slice(2)).then(
    // Exit only after stdout drains: a piped listing larger than the pipe
    // buffer is otherwise truncated by process.exit.
    (code) => process.stdout.write('', () => process.exit(code)),
    (error: unknown) => {
      console.error('[tether] fatal:', error)
      process.exit(1)
    },
  )
}
