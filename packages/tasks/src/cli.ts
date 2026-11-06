// `aico projects ...`: the projects registry.

import { type ParseArgsOptionsConfig, parseArgs } from 'node:util'
import type { Database } from './db'
import { ProjectError, Registry } from './projects'

export interface Io {
  out(line: string): void
  err(line: string): void
}

export interface Deps {
  db: Database
  now?: () => number
  cwd: string
  env: NodeJS.ProcessEnv
}

class UsageError extends Error {}

const PROJECTS_USAGE = `Usage: aico projects <command>
  list [--all]                         registered projects (--all includes retired ones)
  show ID                              one project, its settings and lifecycle events
  register ID --root PATH [--name N] [--category C]
  retire ID --reason TEXT              the project leaves lists; its history stays`

function opts<const T extends ParseArgsOptionsConfig>(argv: string[], options: T) {
  try {
    return parseArgs({ args: argv, options, allowPositionals: true, strict: true })
  } catch (error) {
    throw new UsageError((error as Error).message)
  }
}

function projectJson(registry: Registry, id: string) {
  const project = registry.get(id)
  if (!project) throw new ProjectError(`no project ${id}`)
  return { ...project, lifecycle: project.retired_at === null ? 'active' : 'retired' }
}

export async function runProjects(argv: string[], deps: Deps, io: Io): Promise<number> {
  const [command, ...rest] = argv
  if (!command || command === '--help' || command === '-h' || command === 'help') {
    io.out(PROJECTS_USAGE)
    return command ? 0 : 2
  }
  const registry = new Registry(deps.db, deps.now)
  try {
    if (command === 'list') {
      const { values } = opts(rest, { all: { type: 'boolean' } })
      const current = registry.forCwd(deps.cwd)?.id ?? deps.env.AICO_PROJECT_ID
      io.out(
        JSON.stringify(
          registry.list({ all: values.all }).map((p) => ({
            id: p.id,
            name: p.name,
            root_path: p.root_path,
            current: p.id === current,
          })),
        ),
      )
    } else if (command === 'show' || command === 'get') {
      const id = rest[0]
      if (!id) throw new UsageError('aico projects show ID')
      io.out(JSON.stringify({ ...projectJson(registry, id), events: registry.events(id) }, null, 2))
    } else if (command === 'register') {
      const { values, positionals } = opts(rest, {
        root: { type: 'string' },
        name: { type: 'string' },
        category: { type: 'string' },
      })
      if (!positionals[0] || !values.root)
        throw new UsageError('aico projects register ID --root PATH [--name N]')
      registry.register({
        id: positionals[0],
        root: values.root,
        name: values.name,
        category: values.category,
      })
      io.out(`PASS Project ${positionals[0]} registered.`)
    } else if (command === 'retire') {
      const { values, positionals } = opts(rest, { reason: { type: 'string', short: 'r' } })
      if (!positionals[0]) throw new UsageError('aico projects retire ID --reason TEXT')
      registry.retire(positionals[0], values.reason ?? '')
      io.out(`PASS Project ${positionals[0]} retired.`)
    } else {
      io.err(`aico projects: unknown command '${command}'`)
      io.err(PROJECTS_USAGE)
      return 2
    }
    return 0
  } catch (error) {
    if (error instanceof UsageError) {
      io.err(`ERROR ${error.message}`)
      return 2
    }
    if (error instanceof ProjectError) {
      io.err(`ERROR ${error.message}`)
      return 1
    }
    throw error
  }
}
