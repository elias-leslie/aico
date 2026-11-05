// aico-ops: `aico deploy`, `aico logs`, `aico snapshots` and `aico vm` (the launcher routes those here).

import { existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { backups } from './backups'
import {
  canonical,
  defaultDeps,
  deploy,
  jobResult,
  loadProject,
  NOT_HANDLED,
  parseDeployArgs,
  Refusal,
} from './deploy'
import { journalArgs, parseLogsArgs } from './logs'
import { run } from './sh'
import { snapDeps, snapshots } from './snapshots'
import { routeOp, vm } from './vm'

const USAGE = `Usage:
  aico deploy [PROJECT] [--scope full|backend|frontend|worker|UNIT] [--worker UNIT]... [--include-all-workers]
              [--detach] [--sha REV] [--rollback] [--with-ack ID]
      put one commit live: HEAD when it starts (or --sha), accepted and built in its own release;
      only units whose package cone changed restart; a manual worker (tether@default) only when named
  aico deploy result|wait JOB [--timeout S]   a detached deploy's result (wait: until it ends)
  aico logs UNIT|PROJECT [-n N] [--since 2h] [-l ERROR|WARN|INFO|DEBUG] [-f]
  aico snapshots take [NAME] | list | restore ID|NAME|-N  [--root DIR] [--project ID]
      read-only Btrfs points of the project (the catalogue st snap keeps); restore only for a project
      that is its own subvolume outside the production workspace
  aico vm list | status ID | start ID [--hours H --reason R] | stop ID | snapshot ID [NAME]
      Proxmox guests with Aico Logins' scoped API token (Proxmox enforces its pools)`

/** The repo this launcher belongs to: AICO_REPO_ROOT, else the nearest project.identity.json above cwd. */
export function repoRoot(env = process.env, cwd = process.cwd()): string {
  if (env.AICO_DEPLOY_ROOT) return env.AICO_DEPLOY_ROOT
  if (env.AICO_REPO_ROOT) return env.AICO_REPO_ROOT
  for (let dir = resolve(cwd); ; dir = dirname(dir)) {
    if (existsSync(join(dir, 'project.identity.json'))) return dir
    if (dirname(dir) === dir)
      throw new Refusal('not inside a project (no project.identity.json); set AICO_REPO_ROOT')
  }
}

export async function main(argv: string[], env = process.env): Promise<number> {
  const [verb, ...rest] = argv
  const err = (line: string) => console.error(line)
  try {
    if (verb === 'backups') return await backups(rest, env)
    if (verb === 'deploy') {
      const deps = defaultDeps(env)
      if (rest[0] === 'result' || rest[0] === 'wait') {
        if (!rest[1]) throw new Refusal(`aico deploy ${rest[0]} needs a job id`, 2)
        const at = rest.indexOf('--timeout')
        const timeout = at > 0 ? Number(rest[at + 1]) : undefined
        if (timeout !== undefined && !(timeout >= 0))
          throw new Refusal('--timeout needs seconds', 2)
        return await jobResult(rest[1], rest[0] === 'wait', deps, timeout)
      }
      const req = parseDeployArgs(rest)
      if ('notHandled' in req) {
        if (env.AICO_OPS_CALLER !== 'st')
          err(`aico deploy: ${req.notHandled} is not an aico deploy option`)
        return NOT_HANDLED
      }
      return await deploy(req, repoRoot(env), deps)
    }
    if (verb === 'logs') {
      const req = parseLogsArgs(rest)
      if (typeof req === 'string') throw new Refusal(`aico logs: ${req}`, 2)
      const project = loadProject(repoRoot(env))
      const args = journalArgs(req, project, run)
      if (args) return run('journalctl', args, { inherit: true }).code
      if (env.AICO_OPS_CALLER === 'st') return NOT_HANDLED
      throw new Refusal(`aico logs: no unit ${canonical(req.target)} (user or system)`, 2)
    }
    if (verb === 'snapshots')
      return snapshots(
        rest,
        snapDeps(run, (line) => console.log(line), env),
      )
    if (verb === 'vm') return await vm(rest, routeOp(env), run, (line) => console.log(line), err)
    if (verb === 'help' || verb === '--help' || verb === '-h' || !verb) {
      console.log(USAGE)
      return verb ? 0 : 2
    }
    err(USAGE)
    return 2
  } catch (error) {
    err(`aico ${verb}: ${(error as Error).message}`)
    return error instanceof Refusal ? error.code : 1
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
