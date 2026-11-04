// aico-tasks: the `aico tasks` and `aico projects` commands.

import { TetherClient, tetherSocketPath } from '@aico/tether-client'
import { type Deps, runProjects, runTasks } from './cli'
import { openTasksDb, tasksDbPathFromEnv } from './db'

/** A linked session in a few words from the session history; null when Tether does not know it. */
function sessionDescriber(env: NodeJS.ProcessEnv): Deps['describeSession'] {
  const client = new TetherClient(tetherSocketPath(env, process.getuid?.()), 2_000)
  return async (id) => {
    if (!id.includes(':')) return null
    try {
      const session = await client.historySession(id)
      const outcome = session.outcome ? `, ${session.outcome}` : ''
      return `${session.tool}, ${session.model ?? 'unknown model'}, started ${session.startedAt === null ? 'unknown' : new Date(session.startedAt).toISOString().slice(0, 16).replace('T', ' ')}${outcome}`
    } catch {
      return null
    }
  }
}

export async function main(argv: string[], env = process.env): Promise<number> {
  const [area, ...rest] = argv
  const io = {
    out: (line: string) => console.log(line),
    err: (line: string) => console.error(line),
  }
  if (area !== 'tasks' && area !== 'projects') {
    io.err('Usage: aico-tasks <tasks|projects> ...')
    return 2
  }
  if (rest.length === 0 || rest[0] === '--help' || rest[0] === 'help') {
    return area === 'tasks'
      ? runTasks(rest, { cwd: process.cwd(), env } as Deps, io)
      : runProjects(rest, { cwd: process.cwd(), env } as Deps, io)
  }
  const db = openTasksDb(tasksDbPathFromEnv(env))
  try {
    const deps: Deps = { db, cwd: process.cwd(), env, describeSession: sessionDescriber(env) }
    return await (area === 'tasks' ? runTasks(rest, deps, io) : runProjects(rest, deps, io))
  } finally {
    db.close()
  }
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (error) => {
      console.error(`aico: ${(error as Error).message}`)
      process.exit(1)
    },
  )
}
