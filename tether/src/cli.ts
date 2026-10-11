import { callSocket } from './client'
import { resolvePaths, type TetherPaths } from './config'
import { startDaemon } from './daemon'
import { runDoctor } from './doctor'
import { VERSION } from './version'

const USAGE = `Usage: tether [--instance NAME] [--json] <command>

Commands:
  serve                         run the daemon (used by tether@<instance>.service)
  doctor                        check host prerequisites and the running daemon
  version                       print the CLI and daemon versions
  sessions [list | get <id>]    session catalog
  roots [list | show <requestId>]
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
        io.out(`tether ${VERSION}`)
        return api(io, paths, json, 'GET', '/v1/version')
      case 'sessions':
        if (!sub || sub === 'list') return api(io, paths, json, 'GET', '/v1/sessions')
        if (sub === 'get' && rest[0])
          return api(io, paths, json, 'GET', `/v1/sessions/${encodeURIComponent(rest[0])}`)
        break
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
    (code) => process.exit(code),
    (error: unknown) => {
      console.error('[tether] fatal:', error)
      process.exit(1)
    },
  )
}
