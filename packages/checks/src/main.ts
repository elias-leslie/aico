// aico-checks: `aico check`, `aico commit` and `aico tasks done` (the launcher routes those here).

import { openTasksDb, tasksDbPathFromEnv } from '@aico/tasks'
import { runCli } from './cli'
import { doneWithReceipt } from './done'
import { hookCoordination } from './hook'
import { postCheckRow } from './status'

export async function main(argv: string[], env = process.env): Promise<number> {
  const [verb, ...rest] = argv
  const coordination = hookCoordination(env)
  const out = (line: string) => console.log(line)
  const err = (line: string) => console.error(line)
  if (verb === 'check' || verb === 'commit')
    return runCli(verb, rest, {
      out,
      err,
      cwd: process.cwd(),
      env,
      coordination,
      report: (root, summary) => postCheckRow(root, summary, env),
    })
  if (verb === 'tasks' && rest[0] === 'done') {
    const db = openTasksDb(tasksDbPathFromEnv(env))
    try {
      return await doneWithReceipt(
        rest.slice(1),
        { db, cwd: process.cwd(), env, coordination },
        { out, err },
      )
    } finally {
      db.close()
    }
  }
  err('Usage: aico-checks <check|commit|tasks done> ...')
  return 2
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
