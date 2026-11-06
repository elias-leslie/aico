// aico-checks: `aico check`, `aico commit`, `aico nightly`, and `aico publish`
// (the launcher routes those here).

import { runCli } from './cli'
import { hookCoordination } from './hook'
import { nightlyCli } from './nightly'
import { publishCli } from './publish'
import { postCheckRow } from './status'

export async function main(argv: string[], env = process.env): Promise<number> {
  const [verb, ...rest] = argv
  if (verb === 'publish') return publishCli(rest, env)
  if (verb === 'nightly') return nightlyCli(rest, env)
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
  err('Usage: aico-checks <check|commit|nightly|publish> ...')
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
