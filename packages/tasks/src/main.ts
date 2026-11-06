// aico-tasks: the `aico projects` and `aico pulse` commands.

import { type Deps, runProjects } from './cli'
import { openTasksDb, tasksDbPathFromEnv } from './db'
import { runPulse } from './pulse-cli'

export async function main(argv: string[], env = process.env): Promise<number> {
  const [area, ...rest] = argv
  const io = {
    out: (line: string) => console.log(line),
    err: (line: string) => console.error(line),
  }
  if (area !== 'projects' && area !== 'pulse') {
    io.err('Usage: aico-tasks <projects|pulse> ...')
    return 2
  }
  if (area !== 'pulse' && (rest.length === 0 || rest[0] === '--help' || rest[0] === 'help')) {
    return runProjects(rest, { cwd: process.cwd(), env } as Deps, io)
  }
  const db = openTasksDb(tasksDbPathFromEnv(env))
  try {
    const deps: Deps = { db, cwd: process.cwd(), env }
    if (area === 'pulse') return await runPulse(rest, { db, cwd: deps.cwd, env }, io)
    return await runProjects(rest, deps, io)
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
