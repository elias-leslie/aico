// aico-jobs: the scheduler service and its CLI (`aico jobs ...`).

import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { machineId, type StatusRow } from '@aico/status'
import { act } from './act'
import { type JobDef, readJobs } from './jobs'
import { JobStore, jobsDbPath } from './leases'
import { jobRow, Runner } from './runner'

const USAGE = `Usage: aico jobs <command>
  list           each job: its home machine, when it runs next, who holds it, how it last went
  run KIND       make KIND due now; its home machine runs it within seconds
  serve          run the scheduler (aico-jobs.service)
    --machine M  act as machine M (a takeover drill on one host)
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
    jobsFile: env.AICO_JOBS_FILE?.trim() || here('../data/jobs.json'),
    dbPath: env.AICO_JOBS_DB?.trim() || jobsDbPath(dataDir),
    webUrl,
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

function list(store: JobStore, jobs: readonly JobDef[]): void {
  for (const job of jobs) {
    const state = store.get(job.kind)
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
  const { jobsFile, dbPath, webUrl } = settings(env)
  const jobs = readJobs(jobsFile)
  const store = new JobStore(dbPath)
  if (command === 'list') {
    list(store, jobs)
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
    if (!store.runNow(job.kind, Date.now())) {
      console.error(`aico jobs run: aico-jobs has not started ${job.kind} yet`)
      return 1
    }
    console.log(`${job.kind} is due now; ${job.home} runs it within ${TICK_MS / 1000} s.`)
    return 0
  }
  if (command !== 'serve') {
    console.error(`aico jobs: unknown command '${command}'\n${USAGE}`)
    return 2
  }
  const flag = rest.indexOf('--machine')
  const machine = flag >= 0 ? (rest[flag + 1] ?? '').toLowerCase() : machineId()
  if (!machine) {
    console.error('aico jobs serve: --machine needs a name')
    return 2
  }
  const runner = new Runner({
    store,
    jobs,
    machine,
    holder: `${machine}:${process.pid}`,
    act: act(webUrl),
    postRows: (rows) => postRows(webUrl, rows),
  })
  runner.start()
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
