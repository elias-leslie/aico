// aico-checks: `aico check`, `aico commit`, `aico nightly`, and `aico publish`
// (the launcher routes those here).

import { spawn } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { runCli } from './cli'
import { hookCoordination } from './hook'
import { nightlyCli } from './nightly'
import { publishCli } from './publish'
import { postCheckRow } from './status'

/**
 * After a commit: `aico wip run PROJECT` in the background, so the other full machines get it now rather than at the
 * next job run. One run per repo at a time (flock -n); a commit that lands mid-run goes out with the next job run.
 * Nothing here can fail the commit.
 */
function copyToPeers(root: string, env: NodeJS.ProcessEnv): void {
  try {
    const id = (
      JSON.parse(readFileSync(join(root, 'project.identity.json'), 'utf8')) as {
        project: { id: string }
      }
    ).project.id
    const lock = join(env.XDG_RUNTIME_DIR || '/tmp', `aico-wip-${id}.lock`)
    const child = spawn('flock', ['-n', lock, 'aico', 'wip', 'run', id], {
      detached: true,
      stdio: 'ignore',
      env,
    })
    child.on('error', () => {})
    child.unref()
  } catch {}
}

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
      copy: (root) => copyToPeers(root, env),
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
