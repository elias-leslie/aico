// A test run's temp folders live in one folder of its own, removed when the run ends, so tests that
// never clean up can't fill the machine's /tmp. A killed run's folder goes with the next run.
import { mkdirSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// Short: tmux refuses a socket path near the 108-byte limit, and test paths sit close to it.
const PREFIX = 'vt-'

const running = (pid: number) => {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== 'ESRCH'
  }
}

/** Removes the folders of runs that ended without removing their own. */
export function sweepRuns(top: string, alive = running): string[] {
  const gone = readdirSync(top).filter((name) => {
    const pid = name.startsWith(PREFIX) ? Number.parseInt(name.slice(PREFIX.length), 10) : 0
    return pid > 0 && !alive(pid)
  })
  for (const name of gone) rmSync(join(top, name), { recursive: true, force: true })
  return gone
}

/** Vitest's global setup; the run's test workers inherit TMPDIR, so os.tmpdir() answers this folder. */
export default function setup() {
  const top = tmpdir()
  sweepRuns(top) // A folder from a dead run with this pid goes here too.
  const dir = join(top, `${PREFIX}${process.pid}`)
  mkdirSync(dir)
  process.env.TMPDIR = dir
  return () => rmSync(dir, { recursive: true, force: true })
}
