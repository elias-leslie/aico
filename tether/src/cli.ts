import { spawnSync } from 'node:child_process'
import { callSocket } from './client'
import { resolvePaths, type TetherPaths } from './config'
import { startDaemon } from './daemon'
import { runDoctor } from './doctor'
import { applyImport, formatPlan, planImportForPath, summarize } from './importer'
import { Store } from './store'
import { VERSION } from './version'

const USAGE = `Usage: tether [--instance NAME] [--json] <command>

Commands:
  serve                         run the daemon (used by tether@<instance>.service)
  doctor                        check host prerequisites and the running daemon
  version                       print the CLI and daemon versions
  sessions [list | get <id>]    session catalog
  sessions create [--tool T] [--project P] [--name N] [--show]   (alias: new)
  sessions show <id>            open or focus the session's Aico window
  reboot prepare [--timeout SEC] [--no-notify]   ask agents to checkpoint; exit 0 ready, 3 not
  reboot status                 restore results since the last boot
  sessions end <id>             retire one session (reads its generation first)
  sessions attach <id> [--print]
                                attach this terminal (exec tmux); --print shows
                                the argv. Inside another tmux server the client
                                nests with TMUX unset; inside the same server
                                it switches the current client.
  sessions diagnostics <id>
  legacy [list | end <name>]    A-Term summitflow-<uuid> sessions (attach/end only)
  roots [list | show <requestId>]
  import-aico --from PATH [--apply]
                                copy a pre-Tether Aico catalog (an archived
                                aico.db; dry-run unless --apply; opened
                                read-only; stop the daemon first)
  tools [list]                  merged agent-tool registry
  tools get <slug>
  tools add <slug> <name> -- <argv...>
  tools default|enable|disable <slug>
  tools rm <slug>
  projects [--refresh]          project list (SummitFlow, else local)

The instance defaults to $TETHER_INSTANCE or "default".`

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

function render(io: Io, json: boolean, status: number, body: unknown): number {
  if (json || typeof body !== 'object' || body === null) {
    io.out(typeof body === 'string' ? body : JSON.stringify(body, null, 2))
  } else {
    const record = body as Record<string, unknown>
    if (status >= 400) {
      io.err(`error ${status}: ${record.error}${record.detail ? ` — ${record.detail}` : ''}`)
    } else if (
      Array.isArray(record.items) &&
      (record.items as Record<string, unknown>[]).some(
        (item) => 'generation' in item || 'kind' in item,
      )
    ) {
      for (const item of record.items as Record<string, unknown>[]) {
        if (item.kind === 'legacy-attach-only') io.out(`  ${item.name}  (legacy, attach/end only)`)
        else
          io.out(
            `  ${item.id}  ${String(item.status).padEnd(9)} ${String(item.tool).padEnd(12)} ${item.projectId ?? '-'}  ${item.label}`,
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
): Promise<number> {
  try {
    const response = await callSocket(paths.socket, method, path, body)
    return render(io, json, response.status, response.body)
  } catch (error) {
    io.err(
      `tether (${paths.instance}) is not reachable at ${paths.socket}: ${(error as Error).message}`,
    )
    return 2
  }
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

/** Read the session's generation and ask the GUI to show it. A just-created
 * session can take a few seconds to reach running, so a 409 is retried. */
async function showSession(
  paths: TetherPaths,
  id: string,
): Promise<{ status: number; body: unknown }> {
  const path = `/v1/sessions/${encodeURIComponent(id)}`
  let last: { status: number; body: unknown } = { status: 409, body: null }
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const current = await callSocket(paths.socket, 'GET', path, undefined, 15_000)
    const generation = (current.body as Record<string, unknown> | null)?.generation
    if (current.status !== 200 || typeof generation !== 'string') return current
    last = await callSocket(paths.socket, 'POST', `${path}/show`, { generation }, 15_000)
    if (last.status !== 409) return last
    await new Promise((resolve) => setTimeout(resolve, 500))
  }
  return last
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
        if (!sub || sub === 'list') return api(io, paths, json, 'GET', '/v1/sessions')
        if (sub === 'get' && rest[0])
          return api(io, paths, json, 'GET', `/v1/sessions/${encodeURIComponent(rest[0])}`)
        if (sub === 'diagnostics' && rest[0])
          return api(io, paths, json, 'GET', `/v1/sessions/${encodeURIComponent(rest[0])}/${sub}`)
        if (sub === 'attach' && rest[0]) {
          const path = `/v1/sessions/${encodeURIComponent(rest[0])}/attach`
          if (json || rest.includes('--print')) return api(io, paths, json, 'GET', path)
          const response = await callSocket(paths.socket, 'GET', path, undefined, 15_000)
          if (response.status !== 200) return render(io, json, response.status, response.body)
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
          const show = rest.includes('--show')
          const options = flags(
            rest.filter((arg) => arg !== '--show'),
            ['--tool', '--project', '--name'],
          )
          const body: Record<string, unknown> = {
            origin: 'cli',
            size: { cols: process.stdout.columns || 120, rows: process.stdout.rows || 40 },
          }
          if (options['--tool']) body.tool = options['--tool']
          if (options['--project']) body.projectId = options['--project']
          if (options['--name']) body.name = options['--name']
          if (!show) return api(io, paths, json, 'POST', '/v1/sessions', body)
          const created = await callSocket(paths.socket, 'POST', '/v1/sessions', body, 60_000)
          const id = (created.body as Record<string, unknown> | null)?.id
          if (created.status >= 300 || typeof id !== 'string')
            return render(io, json, created.status, created.body)
          const shown = await showSession(paths, id)
          if (shown.status !== 200) io.err(`tether: created ${id} but could not show it`)
          return render(io, json, created.status, created.body)
        }
        if (sub === 'show' && rest[0]) {
          const shown = await showSession(paths, rest[0])
          return render(io, json, shown.status, shown.body)
        }
        if (sub === 'end' && rest[0]) {
          const path = `/v1/sessions/${encodeURIComponent(rest[0])}`
          const current = await callSocket(paths.socket, 'GET', path, undefined, 15_000)
          const generation = (current.body as Record<string, unknown> | null)?.generation
          if (current.status !== 200 || typeof generation !== 'string')
            return render(io, json, current.status, current.body)
          return api(io, paths, json, 'POST', `${path}/end`, { generation })
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
      case 'legacy':
        if (!sub || sub === 'list') return api(io, paths, json, 'GET', '/v1/legacy-sessions')
        if (sub === 'end' && rest[0])
          return api(
            io,
            paths,
            json,
            'POST',
            `/v1/legacy-sessions/${encodeURIComponent(rest[0])}/end`,
          )
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
      case 'roots':
        if (!sub || sub === 'list') return api(io, paths, json, 'GET', '/v1/roots')
        if (sub === 'show' && rest[0])
          return api(io, paths, json, 'GET', `/v1/roots/${encodeURIComponent(rest[0])}`)
        break
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
    io.err((error as Error).message)
    return 2
  }
  io.err(USAGE)
  return 2
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
