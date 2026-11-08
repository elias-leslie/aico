// `aico deploy boot-clean`: what a reboot or power cut left that nothing else would ever clear.
// aico-jobs asks for it each time it starts, on every Aico machine. Only things last touched before
// this boot count (their process can't have survived it), so a run during normal work finds nothing.
// One log line per thing cleared, no notices.

import { readdirSync, readFileSync, readlinkSync, rmSync, statSync, utimesSync } from 'node:fs'
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
    const id = name.slice(0, -'.json'.length)
    let job: Job | null = null
    try {
      job = JSON.parse(readFileSync(path, 'utf8'))
    } catch {}
    // One record that can't be fixed must not stop the rest of the cleanup.
    try {
      if (!job || typeof job !== 'object') {
        if (!dryRun) rmSync(path, { force: true })
        say(deps, `${dryRun ? 'would remove' : 'removed'} the unreadable deploy record ${name}`)
        cleared++
      } else if (job.state === 'running' || job.state === 'queued') {
        if (!dryRun)
          writeJob(deps, {
            ...job,
            id,
            state: 'failed',
            message: FINISHED_BY_REBOOT,
            exit_code: 1,
            finished_at: new Date().toISOString(),
          })
        say(deps, `${dryRun ? 'would mark' : 'marked'} deploy ${id} failed: it was ${job.state}`)
        cleared++
      }
    } catch (error) {
      say(deps, `could not clear deploy record ${name}: ${(error as Error).message}`)
      cleared++
    }
  }
  return cleared
}

/** The deploy lock's pid may be some new process after a boot, which would look like a live deploy forever. */
function clearDeployLock(deps: DeployDeps, bootMs: number, dryRun: boolean): number {
  const lock = join(deps.releasesDir, '.deploy.pid')
  // Read first: takeOver only moves the file while it still says this, so a deploy that replaced it since is safe.
  let held: string
  try {
    held = readFileSync(lock, 'utf8')
  } catch {
    return 0
  }
  const at = touchedAt(lock)
  if (at === null || at >= bootMs) return 0
  if (!dryRun) takeOver(lock, held)
  say(deps, `${dryRun ? 'would clear' : 'cleared'} the deploy lock left from before this boot`)
  return 1
}

async function clearSwap(
  deps: DeployDeps,
  bootMs: number,
  dryRun: boolean,
  holdsRoot: string,
): Promise<number> {
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
  const held = holdRefusal(holdsRoot, [], deps)
  if (held) {
    say(deps, `left the interrupted deploy for the next one, which puts it back: ${held}`)
    return 1
  }
  try {
    // Under the deploy lock, as a deploy does it; a new deploy may have got there first. recoverSwap logs its line.
    return await withLock(deps, async () => {
      if (!stale()) return 0
      // One try per boot: putting units back can restart aico-jobs, which asks for this again.
      const now = new Date()
      utimesSync(journal, now, now)
      recoverSwap(deps)
      return 1
    })
  } catch (error) {
    say(
      deps,
      `could not put back the interrupted deploy; the next deploy tries again: ${(error as Error).message}`,
    )
    return 1
  }
}

interface Listed {
  id?: string
  root_path?: string | null
}

function listProjects(deps: DeployDeps): Listed[] {
  const listed = deps.run(deps.env.AICO_BIN || 'aico', ['projects', 'list', '--json'], {
    env: deps.env,
  })
  try {
    if (listed.code === 0) return JSON.parse(listed.out) as Listed[]
  } catch {}
  say(deps, 'could not list the projects, so their git locks were not checked')
  return []
}

function clearGitLocks(
  deps: DeployDeps,
  projects: Listed[],
  bootMs: number,
  dryRun: boolean,
  gitBusy: (root: string) => boolean,
): number {
  let cleared = 0
  for (const { root_path: root } of projects)
    for (const name of root ? GIT_LOCKS : []) {
      if (!root) continue
      const lock = join(root, '.git', name)
      const at = touchedAt(lock)
      if (at === null || at >= bootMs) continue
      if (gitBusy(root)) {
        say(deps, `left ${lock}: git is running there`)
        cleared++
        continue
      }
      try {
        if (!dryRun) rmSync(lock, { force: true })
        say(deps, `${dryRun ? 'would remove' : 'removed'} ${lock}, left from before this boot`)
      } catch (error) {
        say(deps, `could not remove ${lock}: ${(error as Error).message}`)
      }
      cleared++
    }
  return cleared
}

export async function bootClean(deps: DeployDeps, options: BootCleanOptions = {}): Promise<number> {
  const bootMs = options.bootMs ?? Date.now() - uptime() * 1000
  const dryRun = options.dryRun ?? false
  const projects = listProjects(deps)
  // Holds are per project, and a deploy of Aico checks them from its checkout.
  const holdsRoot = projects.find((p) => p.id === 'aico')?.root_path ?? deps.releasesDir
  const cleared =
    clearDeployRecords(deps, bootMs, dryRun) +
    clearDeployLock(deps, bootMs, dryRun) +
    (await clearSwap(deps, bootMs, dryRun, holdsRoot)) +
    clearGitLocks(deps, projects, bootMs, dryRun, options.gitBusy ?? gitBusyIn)
  if (!cleared) say(deps, 'nothing left over from before this boot')
  return 0
}
