// `aico deploy boot-clean`: what a reboot or power cut left that nothing else would ever clear.
// aico-jobs asks for it each time it starts, on every Aico machine. Only things last touched before
// this boot count (their process can't have survived it), so a run during normal work finds nothing.
// One log line per thing cleared, no notices.

import { readdirSync, readFileSync, readlinkSync, rmSync, statSync } from 'node:fs'
import { uptime } from 'node:os'
import { join, sep } from 'node:path'
import {
  type DeployDeps,
  holdRefusal,
  type Job,
  journalPath,
  recoverSwap,
  takeOver,
  withLock,
  writeJob,
} from './deploy'

const say = (deps: DeployDeps, line: string) => deps.out(`[boot-clean] ${line}`)
export const FINISHED_BY_REBOOT = 'The machine restarted during this deploy, so it did not finish.'
const GIT_LOCKS = ['index.lock', 'HEAD.lock', 'packed-refs.lock']

export interface BootCleanOptions {
  /** When this boot began, epoch ms. uptime, not /proc/stat's btime: in a container btime is the host's boot. */
  bootMs?: number
  dryRun?: boolean
  /** Whether a git process is working in this checkout. */
  gitBusy?: (root: string) => boolean
}

function touchedAt(path: string): number | null {
  try {
    return statSync(path).mtimeMs
  } catch {
    return null
  }
}

/** A git process (or one of its helpers) whose working folder is in this checkout; a folder we may not read counts. */
export function gitBusyIn(root: string, proc = '/proc'): boolean {
  let pids: string[]
  try {
    pids = readdirSync(proc).filter((name) => /^\d+$/.test(name))
  } catch {
    return true
  }
  return pids.some((pid) => {
    try {
      if (!readFileSync(join(proc, pid, 'comm'), 'utf8').startsWith('git')) return false
    } catch {
      return false
    }
    try {
      const cwd = readlinkSync(join(proc, pid, 'cwd'))
      return cwd === root || cwd.startsWith(root + sep)
    } catch {
      return true
    }
  })
}

function clearDeployRecords(deps: DeployDeps, bootMs: number, dryRun: boolean): number {
  let cleared = 0
  let names: string[] = []
  try {
    names = readdirSync(deps.jobsDir)
  } catch {}
  for (const name of names) {
    if (!/^aico-[0-9a-f]{12}\.json$/.test(name)) continue
    const path = join(deps.jobsDir, name)
    const at = touchedAt(path)
    if (at === null || at >= bootMs) continue
    let job: Job | null = null
    try {
      job = JSON.parse(readFileSync(path, 'utf8'))
    } catch {}
    if (!job || typeof job !== 'object') {
      say(deps, `${dryRun ? 'would remove' : 'removed'} the unreadable deploy record ${name}`)
      if (!dryRun) rmSync(path, { force: true })
      cleared++
    } else if (job.state === 'running' || job.state === 'queued') {
      say(deps, `${dryRun ? 'would mark' : 'marked'} deploy ${job.id} failed: it was ${job.state}`)
      if (!dryRun)
        writeJob(deps, {
          ...job,
          state: 'failed',
          message: FINISHED_BY_REBOOT,
          exit_code: 1,
          finished_at: new Date().toISOString(),
        })
      cleared++
    }
  }
  return cleared
}

/** The deploy lock's pid may be some new process after a boot, which would look like a live deploy forever. */
function clearDeployLock(deps: DeployDeps, bootMs: number, dryRun: boolean): number {
  const lock = join(deps.releasesDir, '.deploy.pid')
  const at = touchedAt(lock)
  if (at === null || at >= bootMs) return 0
  say(deps, `${dryRun ? 'would clear' : 'cleared'} the deploy lock left from before this boot`)
  if (!dryRun)
    try {
      takeOver(lock, readFileSync(lock, 'utf8'))
    } catch {}
  return 1
}

async function clearSwap(deps: DeployDeps, bootMs: number, dryRun: boolean): Promise<number> {
  const journal = journalPath(deps)
  const stale = () => {
    const at = touchedAt(journal)
    return at !== null && at < bootMs
  }
  if (!stale()) return 0
  if (dryRun) {
    say(deps, 'would put back the units of the deploy this boot interrupted (.swap.json)')
    return 1
  }
  const held = holdRefusal(deps.releasesDir, [], deps)
  if (held) {
    say(deps, `left the interrupted deploy for the next one, which puts it back: ${held}`)
    return 0
  }
  try {
    // Under the deploy lock, as a deploy does it; a new deploy may have got there first. recoverSwap logs its line.
    return await withLock(deps, async () => {
      if (!stale()) return 0
      recoverSwap(deps)
      return 1
    })
  } catch (error) {
    say(
      deps,
      `could not put back the interrupted deploy; the next deploy tries again: ${(error as Error).message}`,
    )
    return 0
  }
}

function projectRoots(deps: DeployDeps): string[] {
  const listed = deps.run(deps.env.AICO_BIN || 'aico', ['projects', 'list', '--json'], {
    env: deps.env,
  })
  try {
    if (listed.code === 0)
      return (JSON.parse(listed.out) as { root_path?: string | null }[]).flatMap((project) =>
        project.root_path ? [project.root_path] : [],
      )
  } catch {}
  say(deps, 'could not list the projects, so their git locks were not checked')
  return []
}

function clearGitLocks(
  deps: DeployDeps,
  bootMs: number,
  dryRun: boolean,
  gitBusy: (root: string) => boolean,
): number {
  let cleared = 0
  for (const root of projectRoots(deps))
    for (const name of GIT_LOCKS) {
      const lock = join(root, '.git', name)
      const at = touchedAt(lock)
      if (at === null || at >= bootMs) continue
      if (gitBusy(root)) {
        say(deps, `left ${lock}: git is running there`)
        continue
      }
      say(deps, `${dryRun ? 'would remove' : 'removed'} ${lock}, left from before this boot`)
      if (!dryRun) rmSync(lock, { force: true })
      cleared++
    }
  return cleared
}

export async function bootClean(deps: DeployDeps, options: BootCleanOptions = {}): Promise<number> {
  const bootMs = options.bootMs ?? Date.now() - uptime() * 1000
  const dryRun = options.dryRun ?? false
  const cleared =
    clearDeployRecords(deps, bootMs, dryRun) +
    clearDeployLock(deps, bootMs, dryRun) +
    (await clearSwap(deps, bootMs, dryRun)) +
    clearGitLocks(deps, bootMs, dryRun, options.gitBusy ?? gitBusyIn)
  if (!cleared) say(deps, 'nothing left over from before this boot')
  return 0
}
