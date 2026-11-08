// A test run's temp folders live in one folder of its own, removed when the run ends, so tests that
// never clean up can't fill the machine's /tmp. A killed run's folder goes with the next run.
import { mkdirSync, readdirSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// Short: tmux refuses a socket path near the 108-byte limit, and test paths sit close to it.
const RUN_FOLDER = /^vt-(\d+)$/

const running = (pid: number) => {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== 'ESRCH'
  }
}

/** Removes the folders of runs that have ended; one it can't remove stays and never stops a run. */
export function sweepRuns(top: string, alive = running): string[] {
  return readdirSync(top).filter((name) => {
    const pid = Number(name.match(RUN_FOLDER)?.[1] ?? 0)
    if (!pid || alive(pid)) return false
    try {
      if (!statSync(join(top, name)).isDirectory()) return false
      rmSync(join(top, name), { recursive: true, force: true })
      return true
    } catch {
      return false
    }
  })
}

/** Vitest's global setup, which Vitest calls with its project as the argument: nothing it can pass
 * reaches the sweep. */
export default function setup() {
  return startRun()
}

/** Starts a run; its test workers inherit TMPDIR, so os.tmpdir() answers this folder. */
export function startRun(alive = running) {
  const before = process.env.TMPDIR
  const top = tmpdir()
  sweepRuns(top, alive)
  const dir = join(top, `vt-${process.pid}`)
  rmSync(dir, { recursive: true, force: true }) // A dead run's, if the system reused this pid.
  mkdirSync(dir)
  process.env.TMPDIR = dir
  return () => {
    if (before === undefined) delete process.env.TMPDIR
    else process.env.TMPDIR = before
    rmSync(dir, { recursive: true, force: true })
  }
}
