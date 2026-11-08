// Routines: the scheduled work other projects register as data (routines table in jobs.db)
// instead of editing jobs.json. The scheduler reads them with the built-in jobs, so a routine
// takes the same lease, runs as the same kind of unit and writes the same Status row.

import { existsSync, readFileSync, statSync } from 'node:fs'
import { isAbsolute } from 'node:path'
import { type JobDef, KIND, parseJobs, readJobs } from './jobs'
import type { JobStore, Routine } from './leases'

const DEFAULT_LEASE_S = 300
/** The Status row's project field (contracts/status-row.schema.json). */
const PROJECT = /^[a-z0-9][a-z0-9_-]{0,99}$/

/** A routine as a job definition: it runs on the machine it was registered on. */
function routineJob(routine: Routine): JobDef {
  return {
    kind: routine.kind,
    what: routine.what,
    project: routine.project,
    home: routine.host,
    ...(routine.lease_host !== undefined ? { lease_host: routine.lease_host } : {}),
    ...(routine.workers !== undefined ? { workers: routine.workers } : {}),
    ...(routine.at !== undefined ? { at: routine.at } : {}),
    ...(routine.every_min !== undefined ? { every_min: routine.every_min } : {}),
    run: routine.post !== undefined ? { post: routine.post } : { command: routine.command ?? [] },
    lease_s: routine.lease_s,
    source: 'registered',
    scope: routine.scope,
    ...(routine.cwd !== undefined ? { cwd: routine.cwd } : {}),
  }
}

/** jobs.json's jobs plus the registered routines; a registered kind jobs.json also lists is ignored. */
export function loadJobs(jobsFile: string, store: JobStore): JobDef[] {
  const builtIn = readJobs(jobsFile).map((job) => ({ ...job, source: 'built-in' as const }))
  const taken = new Set(builtIn.map((job) => job.kind))
  return [
    ...builtIn,
    ...store
      .routines()
      .filter((routine) => !taken.has(routine.kind))
      .map(routineJob),
  ]
}

/** The machines "either" means, from jobs.json's `either` entry (data, not code). */
export interface EitherHosts {
  home: string
  lease_host: string
  workers: string[]
}

export function readEither(jobsFile: string): EitherHosts | null {
  const either = (JSON.parse(readFileSync(jobsFile, 'utf8')) as { either?: Partial<EitherHosts> })
    .either
  const names = [either?.home, either?.lease_host, ...(either?.workers ?? [])]
  if (
    !either ||
    !names.every((name) => typeof name === 'string' && KIND.test(name)) ||
    !either.workers?.includes(either.home as string) ||
    !either.workers.includes(either.lease_host as string)
  )
    return null
  return either as EitherHosts
}

export interface RoutineInput {
  kind: string
  project: string
  what: string
  host?: string
  at?: string
  every_min?: number
  command?: string[]
  post?: string
  cwd?: string
  scope?: string
  lease_s?: number
  /** `either`: runs on whichever of the machines in jobs.json's `either` entry is online. */
  hosts?: string
}

/**
 * Checks a registration with jobs.json's own rules (so it cannot register what the scheduler would
 * refuse) and returns the stored routine. Throws a sentence naming the bad field.
 */
export function newRoutine(
  input: RoutineInput,
  machine: string,
  taken: ReadonlySet<string>,
  now: number,
  either: EitherHosts | null = null,
): Routine {
  if (input.hosts !== undefined && input.hosts !== 'either' && input.hosts !== 'this')
    throw new Error('--hosts is either (whichever online machine runs it) or this')
  if (input.hosts === 'either' && input.host !== undefined)
    throw new Error('give --hosts either or --host H, not both')
  if (input.hosts === 'either' && !either)
    throw new Error("jobs.json has no 'either' entry naming the machines")
  const host = (
    input.hosts === 'either' ? (either as EitherHosts).home : (input.host ?? machine)
  ).toLowerCase()
  const placement =
    input.hosts === 'either'
      ? {
          lease_host: (either as EitherHosts).lease_host,
          workers: [host, ...(either as EitherHosts).workers.filter((name) => name !== host)],
        }
      : null
  if (!(placement?.workers ?? [host]).includes(machine))
    throw new Error(
      `a routine is registered on a machine that runs it; run this on ${host} (this is ${machine})`,
    )
  if (taken.has(input.kind)) throw new Error(`there is already a routine or job '${input.kind}'`)
  if ((input.command === undefined) === (input.post === undefined))
    throw new Error(
      'give the command to run (--command ARGV...) or an Aico path to POST (--post /path)',
    )
  if (input.command) {
    const file = input.command[0] as string
    if (!isAbsolute(file) && file.includes('/') && !input.cwd)
      throw new Error(`the command '${file}' is relative; give an absolute path or --cwd`)
  }
  if (input.cwd !== undefined && !(existsSync(input.cwd) && statSync(input.cwd).isDirectory()))
    throw new Error(`--cwd ${input.cwd} is not a folder on ${machine}`)
  if (!PROJECT.test(input.project))
    throw new Error(
      '--project is the project id: lower-case letters, digits, dashes and underscores',
    )
  const lease_s = input.lease_s ?? DEFAULT_LEASE_S
  const [job] = parseJobs({
    jobs: [
      {
        kind: input.kind,
        what: input.what,
        project: input.project,
        home: host,
        ...(input.at !== undefined ? { at: input.at } : {}),
        ...(input.every_min !== undefined ? { every_min: input.every_min } : {}),
        run: input.post !== undefined ? { post: input.post } : { command: input.command },
        lease_s,
        scope: input.scope ?? 'user',
      },
    ],
  }) as [JobDef]
  return {
    kind: job.kind,
    project: job.project,
    what: job.what,
    host,
    ...(job.at !== undefined ? { at: job.at } : {}),
    ...(job.every_min !== undefined ? { every_min: job.every_min } : {}),
    ...('command' in job.run ? { command: job.run.command } : { post: job.run.post }),
    ...(placement ?? {}),
    ...(input.cwd !== undefined ? { cwd: input.cwd } : {}),
    scope: job.scope ?? 'user',
    lease_s,
    created_at: now,
  }
}
