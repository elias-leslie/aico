// aico-jobs: the scheduler service and its CLI (`aico jobs ...`).

import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { peerDir } from '@aico/fleet/hosts'
import { drainOutbox, machineId, outboxDir, type StatusRow } from '@aico/status'
import { act, postJob, systemdUnits, unitInFlight } from './act'
import { remoteAuthority, serveLeases } from './fleet-leases'
import { type JobDef, readJobs } from './jobs'
import { type JobState, JobStore, jobsDbPath } from './leases'
import { jobRow, type LeaseAuthority, Runner } from './runner'

const USAGE = `Usage: aico jobs <command>
  list           each job: its home machine and lease holder, when it runs next, who holds it, how it last went
  run KIND       make KIND due at its lease holder; an eligible worker runs it
  serve          run the scheduler (aico-jobs.service): eligible jobs, using their configured lease holders
  post PATH      POST to aico-web and print the result as JSON (what a POST job's unit runs)
  --machine M    act as machine M (tests and drills on one host)
Settings: AICO_JOBS_FILE (job list, default data/jobs.json), AICO_JOBS_DB (default jobs.db in
AICO_DATA_DIR or ~/.local/state/aico), AICO_WEB_URL (aico-web, for jobs and Status rows).`

const TICK_MS = 5_000

function here(path: string): string {
  return fileURLToPath(new URL(path, import.meta.url))
}

function settings(env: NodeJS.ProcessEnv) {
  const dataDir = resolve(
    env.AICO_DATA_DIR?.trim() ||
      join(env.XDG_STATE_HOME?.trim() || join(homedir(), '.local', 'state'), 'aico'),
  )
  let webUrl = env.AICO_WEB_URL?.trim()
  if (!webUrl) {
    const identity = JSON.parse(readFileSync(here('../../../project.identity.json'), 'utf8'))
    webUrl = `http://127.0.0.1:${identity.runtime.backend_port}`
  }
  return {
    dataDir,
    jobsFile: env.AICO_JOBS_FILE?.trim() || here('../data/jobs.json'),
    dbPath: env.AICO_JOBS_DB?.trim() || jobsDbPath(dataDir),
    webUrl,
    socket:
      env.AICO_JOBS_SOCKET ||
      join(env.XDG_RUNTIME_DIR || `/run/user/${process.getuid?.() ?? 0}`, 'aico/jobs.sock'),
  }
}

async function postRows(webUrl: string, rows: StatusRow[]): Promise<void> {
  const res = await fetch(new URL('/api/status/rows', webUrl), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(rows),
    signal: AbortSignal.timeout(10_000),
  })
  if (!res.ok)
    throw new Error(`aico-web answered ${res.status}: ${(await res.text()).slice(0, 200)}`)
}

const time = (ms: number | null) => (ms === null ? '-' : new Date(ms).toLocaleString('sv-SE'))

async function list(
  jobs: readonly JobDef[],
  authority: (job: JobDef) => LeaseAuthority,
): Promise<void> {
  for (const job of jobs) {
    let state: JobState | null
    try {
      state = await authority(job).get(job.kind)
    } catch (error) {
      console.log(
        `${job.kind}  lease holder ${job.lease_host ?? job.home} unavailable: ${(error as Error).message}`,
      )
      continue
    }
    if (!state) {
      console.log(`${job.kind}  home ${job.home}  not started by aico-jobs yet`)
      continue
    }
    const row = jobRow(job, state)
    const held = state.leaseId ? `  held by ${state.holder} (lease ${state.fence})` : ''
    console.log(`${job.kind}  home ${job.home}  next ${time(state.nextRun)}${held}`)
    console.log(
      `  last ${time(state.lastRun)} on ${state.lastMachine ?? '-'}: ${row.state}: ${row.meaning}`,
    )
  }
}

export async function main(argv: string[], env = process.env): Promise<number> {
  const [command, ...rest] = argv
  if (!command || command === 'help' || command === '--help' || command === '-h') {
    console.log(USAGE)
    return command ? 0 : 2
  }
  if (command === 'post') {
    if (!rest[0]?.startsWith('/')) {
      console.error('aico jobs post: needs a path starting with /')
      return 2
    }
    console.log(JSON.stringify(await postJob(settings(env).webUrl, rest[0])))
    return 0
  }
  const flag = rest.indexOf('--machine')
  const machine = flag >= 0 ? (rest[flag + 1] ?? '').toLowerCase() : machineId()
  if (!machine) {
    console.error('aico jobs: --machine needs a name')
    return 2
  }
  const { dataDir, jobsFile, dbPath, webUrl, socket } = settings(env)
  const jobs = readJobs(jobsFile)
  const store = new JobStore(dbPath)
  const authority = (job: JobDef) =>
    (job.lease_host ?? job.home) === machine
      ? store
      : remoteAuthority(
          join(peerDir(env, process.getuid?.(), job.lease_host ?? job.home), 'jobs.sock'),
        )
  if (command === 'list') {
    if (rest.includes('--json')) {
      const result = []
      for (const job of jobs) {
        try {
          result.push({ kind: job.kind, home: job.home, state: await authority(job).get(job.kind) })
        } catch {
          result.push({ kind: job.kind, home: job.home, state: null })
        }
      }
      console.log(JSON.stringify(result))
    } else await list(jobs, authority)
    store.close()
    return 0
  }
  if (command === 'run') {
    const job = jobs.find((candidate) => candidate.kind === rest[0])
    if (!job) {
      console.error(
        `aico jobs run: no job '${rest[0] ?? ''}' (known: ${jobs.map((j) => j.kind).join(', ')})`,
      )
      return 2
    }
    let due: boolean
    try {
      due =
        (job.lease_host ?? job.home) === machine
          ? store.runNow(job.kind, Date.now())
          : await remoteAuthority(
              join(peerDir(env, process.getuid?.(), job.lease_host ?? job.home), 'jobs.sock'),
            ).run(job.kind)
    } catch (error) {
      console.error(
        `aico jobs run: lease holder ${job.lease_host ?? job.home} is not reachable: ${(error as Error).message}`,
      )
      store.close()
      return 1
    }
    store.close()
    if (!due) {
      console.error(`aico jobs run: aico-jobs has not started ${job.kind} yet`)
      return 1
    }
    console.log(`${job.kind} is due now; its workers run it within ${TICK_MS / 1000} s.`)
    return 0
  }
  if (command !== 'serve') {
    console.error(`aico jobs: unknown command '${command}'\n${USAGE}`)
    return 2
  }
  // Each job runs as its own systemd unit, so a restart here leaves the run going; the next
  // scheduler adopts it (Runner.adopt) instead of starting a second.
  const units = { host: systemdUnits(env), dir: join(dataDir, 'job-runs') }
  const outbox = { dir: outboxDir(dataDir) }
  const rowsUrl = new URL('/api/status/rows', webUrl).toString()
  const runner = new Runner({
    store,
    jobs,
    machine,
    holder: `${machine}:${process.pid}`,
    authority,
    act: act([process.execPath, process.argv[1] as string], units),
    inFlight: (job) => unitInFlight(job.kind, units),
    drain: async () => void (await drainOutbox(rowsUrl, outbox)),
    postRows: (rows) => postRows(webUrl, rows),
  })
  runner.start()
  await serveLeases(socket, store, jobs, machine)
  console.log(`[jobs] serving ${jobs.length} job(s) as ${machine} from ${jobsFile}`)
  let ticking = false
  const tick = async () => {
    if (ticking) return
    ticking = true
    try {
      await runner.tick()
    } catch (error) {
      console.error('[jobs] tick failed:', error)
    } finally {
      ticking = false
    }
  }
  await tick()
  setInterval(tick, TICK_MS)
  return new Promise<number>(() => {})
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (error) => {
      console.error(`aico jobs: ${(error as Error).message}`)
      process.exit(1)
    },
  )
}
