// `aico deploy [PROJECT]`: puts one commit live. It takes the commit HEAD names when it starts (or
// --sha), accepts that exact commit (`aico check --acceptance --sha`, in a worktree of it), exports
// it into ~/.local/lib/aico/releases/<sha>, builds there and restarts only the units whose package
// cone changed since the commit each one runs. Other builders may commit meanwhile: nothing reads
// the checkout after the start, so HEAD moving never fails or changes the deploy.
//
// Units, ports and manual workers come from the project's project.identity.json (the same file
// SummitFlow's `st service rebuild` reads); a unit's package is the `packages/<dir>` its systemd
// template runs from. Release location, kept releases and extra unit sources are data/ops.json.
//
// The deploy code itself runs from the installed release (`deploy.installedOps`, a link to the release
// whose packages/ops bundle the last deploy built), never from the checkout's working tree: a deploy
// whose commit changes packages/ops (or the root sources) builds that bundle and moves the link.

import { spawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { machineId, type StatusRow } from '@aico/status'
import ops from '../data/ops.json' with { type: 'json' }
import { expandHome, type Runner, run as realRun, tail } from './sh'

/** st's seam treats this exit as "Aico does not deploy that; run SummitFlow's own code". */
export const NOT_HANDLED = 3

export class Refusal extends Error {
  constructor(
    message: string,
    readonly code = 1,
  ) {
    super(message)
  }
}

export interface Project {
  id: string
  /** id plus legacy ids: the names `aico deploy <name>` answers to. */
  names: string[]
  root: string
  backend: string
  port: number
  health: string
  defaultWorkers: string[]
  optionalWorkers: string[]
  manualWorkers: string[]
  manualSources: Record<string, string[]>
}

export const canonical = (unit: string) =>
  /\.(service|socket|timer|scope)$/.test(unit) ? unit : `${unit}.service`

export function loadProject(root: string): Project {
  const identity = JSON.parse(readFileSync(join(root, 'project.identity.json'), 'utf8'))
  const services = identity.services ?? {}
  const runtime = identity.runtime ?? {}
  const list = (value: unknown) => (Array.isArray(value) ? value.map(String).map(canonical) : [])
  const manualSources: Record<string, string[]> = {}
  for (const [unit, paths] of Object.entries(services.manual_worker_sources ?? {}))
    manualSources[canonical(unit)] = Array.isArray(paths) ? paths.map(String) : []
  return {
    id: identity.project.id,
    names: [identity.project.id, ...(identity.project.legacy_ids ?? [])],
    root,
    backend: services.backend ? canonical(services.backend) : '',
    port: Number(runtime.backend_port) || 0,
    health: runtime.health_endpoint || '/health',
    defaultWorkers: list(services.default_workers),
    optionalWorkers: list(services.optional_workers),
    manualWorkers: list(services.manual_workers),
    manualSources,
  }
}

export interface DeployRequest {
  project: string
  sha?: string
  scope?: string
  workers: string[]
  includeAllWorkers: boolean
  detach: boolean
  rollback: boolean
  withAck?: string
  /** Internal: the detached run of a queued job. */
  job?: string
}

/** The flags `st service rebuild` passes; any other flag is SummitFlow's to run. */
export function parseDeployArgs(argv: string[]): DeployRequest | { notHandled: string } {
  const req: DeployRequest = {
    project: '',
    workers: [],
    includeAllWorkers: false,
    detach: false,
    rollback: false,
  }
  const value = (i: number, flag: string) => {
    const next = argv[i + 1]
    if (next === undefined || next.startsWith('--')) throw new Refusal(`${flag} needs a value`, 2)
    return next
  }
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i] as string
    const [flag, inline] = arg.startsWith('--') && arg.includes('=') ? arg.split(/=(.*)/s) : [arg]
    const take = () => (inline !== undefined ? inline : value(i++, flag as string))
    switch (flag) {
      case '--detach':
        req.detach = true
        break
      case '--include-all-workers':
        req.includeAllWorkers = true
        break
      case '--rollback':
        req.rollback = true
        break
      case '--scope':
        req.scope = take()
        break
      case '--worker':
        req.workers.push(take())
        break
      case '--with-ack':
        req.withAck = take()
        break
      case '--sha':
        req.sha = take()
        break
      case '--job':
        req.job = take()
        break
      case '--acceptance':
        take() // a receipt from st: aico deploy accepts the exact commit itself (a pass of the tree is reused)
        break
      default:
        if (arg.startsWith('-')) return { notHandled: arg }
        if (req.project) throw new Refusal(`one project only (got ${req.project} and ${arg})`, 2)
        req.project = arg
    }
  }
  return req
}

export interface Selection {
  restart: string[]
  /** Manual workers whose sources changed, left running (they restart only when named). */
  stale: string[]
}

export interface SelectContext {
  active(unit: string): boolean
  changed(unit: string): boolean
}

/** Which units this deploy restarts; refuses the combinations st refused. */
export function selectUnits(project: Project, req: DeployRequest, ctx: SelectContext): Selection {
  const regular = [project.backend, ...project.defaultWorkers, ...project.optionalWorkers].filter(
    Boolean,
  )
  const declared = [...regular, ...project.manualWorkers]
  const workers = req.workers.map(canonical)
  let scope = req.scope
  if (scope && !['full', 'backend', 'frontend', 'worker'].includes(scope)) {
    const unit = canonical(scope)
    if (!declared.includes(unit))
      throw new Refusal(
        `Unknown scope ${scope}: use full, backend, frontend, worker or one of ${declared.join(', ')}`,
      )
    if (project.manualWorkers.includes(unit)) workers.push(unit)
    scope = project.manualWorkers.includes(unit) ? undefined : unit
  }
  const unknown = workers.filter((unit) => !declared.includes(unit))
  if (unknown.length)
    throw new Refusal(`Unknown worker ${unknown.join(', ')}; declared: ${declared.join(', ')}`)
  if (scope === 'frontend' && (workers.length || req.includeAllWorkers))
    throw new Refusal('A frontend-only scope cannot be combined with worker selection.')
  const manual = workers.filter((unit) => project.manualWorkers.includes(unit))
  if (
    manual.length &&
    (manual.length !== workers.length || req.includeAllWorkers || (scope && scope !== 'full'))
  )
    throw new Refusal(
      'A manual worker deploys alone: drop other workers, --scope and --include-all-workers.',
    )
  if (manual.length) return { restart: [...new Set(manual)], stale: [] }

  const optional = project.optionalWorkers.filter(
    (unit) => req.includeAllWorkers || ctx.active(unit),
  )
  let forced: string[] = []
  let candidates: string[] = []
  if (!scope || scope === 'full')
    candidates = [project.backend, ...project.defaultWorkers, ...optional]
  else if (scope === 'backend' || scope === 'frontend') forced = [project.backend]
  else if (scope === 'worker') forced = [project.backend, ...project.defaultWorkers, ...optional]
  else forced = [scope]
  const restart = regular.filter(
    (unit) =>
      forced.includes(unit) ||
      workers.includes(unit) ||
      (candidates.includes(unit) && ctx.changed(unit)),
  )
  const stale = project.manualWorkers.filter((unit) => ctx.changed(unit))
  return { restart, stale }
}

// ---- package cones -------------------------------------------------------------------------

export interface Pkg {
  dir: string
  name: string
  deps: string[]
}

/** The workspace packages at a commit: dir, name and workspace dependencies. */
export function readPackages(git: (args: string[]) => string, sha: string): Pkg[] {
  const dirs = git(['ls-tree', '--name-only', `${sha}:packages`])
    .split('\n')
    .filter(Boolean)
  const raw: { dir: string; json: Record<string, unknown> }[] = []
  for (const dir of dirs) {
    try {
      raw.push({ dir, json: JSON.parse(git(['show', `${sha}:packages/${dir}/package.json`])) })
    } catch {}
  }
  const names = new Set(raw.map((item) => String(item.json.name)))
  return raw.map(({ dir, json }) => ({
    dir,
    name: String(json.name),
    deps: ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies']
      .flatMap((field) => Object.keys((json[field] as Record<string, string> | undefined) ?? {}))
      .filter((name) => names.has(name)),
  }))
}

/** packages/<dir> and every workspace package it depends on, directly or not. */
export function cone(packages: Pkg[], dir: string): string[] {
  const byName = new Map(packages.map((pkg) => [pkg.name, pkg]))
  const start = packages.find((pkg) => pkg.dir === dir)
  if (!start) return [`packages/${dir}`]
  const seen = new Set<Pkg>()
  const visit = (pkg: Pkg | undefined) => {
    if (!pkg || seen.has(pkg)) return
    seen.add(pkg)
    for (const dep of pkg.deps) visit(byName.get(dep))
  }
  visit(start)
  return [...seen].map((pkg) => `packages/${pkg.dir}`).sort()
}

/** The package a unit template runs from (`__PROJECT_ROOT__/packages/<dir>`), if any. */
export const unitPackage = (template: string) =>
  /^WorkingDirectory=__PROJECT_ROOT__\/packages\/([A-Za-z0-9_-]+)/m.exec(template)?.[1] ?? null

/** Every path whose change means the unit runs different code. */
export function unitSources(
  project: Project,
  unit: string,
  template: string,
  packages: Pkg[],
): string[] {
  const extra: string[] = (ops.deploy.unitSources as Record<string, string[]>)[unit] ?? []
  const pkg = unitPackage(template)
  const sources = [
    `scripts/systemd/${unit}`,
    ...ops.deploy.rootSources,
    ...(pkg ? cone(packages, pkg) : []),
    ...extra.flatMap((path) =>
      path.startsWith('packages/') ? cone(packages, path.slice(9)) : [path],
    ),
    ...(project.manualSources[unit] ?? []),
  ]
  return [...new Set(sources)]
}

export const touches = (paths: string[], sources: string[]) =>
  paths.some((path) => sources.some((source) => path === source || path.startsWith(`${source}/`)))

/** The packages a unit needs built in the release: its own and the extra package sources. */
export function unitBuilds(unit: string, template: string): string[] {
  const extra: string[] = (ops.deploy.unitSources as Record<string, string[]>)[unit] ?? []
  const pkg = unitPackage(template)
  return [
    ...(pkg ? [pkg] : []),
    ...extra.filter((p) => p.startsWith('packages/')).map((p) => p.slice(9)),
  ]
}

/** The release commit a rendered unit file runs, when it runs one of ours. */
export function runningSha(unitText: string | null, releasesDir: string): string | null {
  if (!unitText) return null
  const dir = /^WorkingDirectory=(\S+)/m.exec(unitText)?.[1]
  if (!dir?.startsWith(`${releasesDir}/`)) return null
  const sha = dir.slice(releasesDir.length + 1).split('/')[0] ?? ''
  return /^[0-9a-f]{40}$/.test(sha) ? sha : null
}

// ---- the run -------------------------------------------------------------------------------

export interface DeployDeps {
  run: Runner
  out: (line: string) => void
  err: (line: string) => void
  env: NodeJS.ProcessEnv
  releasesDir: string
  jobsDir: string
  systemdDir: string
  /** HTTP GET status of a loopback URL, or 0 when nothing answered. */
  probe: (url: string) => Promise<number>
  sleep: (ms: number) => Promise<void>
  /** Posts the deploy's Status row (best effort). */
  report: (row: StatusRow, port: number) => Promise<void>
  /** The bundle a detached job re-runs. */
  self: string
  /** The link to the release whose ops bundle `aico deploy` runs (data/ops.json deploy.installedOps). */
  opsLink: string
}

export function defaultDeps(env: NodeJS.ProcessEnv = process.env): DeployDeps {
  return {
    run: realRun,
    out: (line) => console.log(line),
    err: (line) => console.error(line),
    env,
    releasesDir: expandHome(env.AICO_RELEASES_DIR || ops.deploy.releasesDir),
    jobsDir: expandHome(env.AICO_DEPLOY_JOBS_DIR || ops.deploy.jobsDir),
    systemdDir: join(env.XDG_CONFIG_HOME || join(homedir(), '.config'), 'systemd', 'user'),
    probe: async (url) => {
      try {
        return (await fetch(url, { signal: AbortSignal.timeout(3_000) })).status
      } catch {
        return 0
      }
    },
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    report: async (row, port) => {
      const base = env.AICO_WEB_URL?.trim() || (port ? `http://127.0.0.1:${port}` : '')
      if (!base) return
      try {
        await fetch(new URL('/api/status/rows', base), {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify([row]),
          signal: AbortSignal.timeout(3_000),
        })
      } catch {}
    },
    self: process.argv[1] ?? '',
    opsLink: expandHome(env.AICO_OPS_INSTALLED || ops.deploy.installedOps),
  }
}

export interface Job {
  id: string
  project: string
  sha: string
  state: 'queued' | 'running' | 'succeeded' | 'failed'
  argv: string[]
  queued_at: string
  finished_at?: string
  units?: string[]
  message?: string
  /** The exit code the deploy ended with (`st service wait` exits with it). */
  exit_code?: number
}

const jobPath = (deps: DeployDeps, id: string) => {
  if (!/^aico-[0-9a-f]{12}$/.test(id)) throw new Refusal(`Not a deploy job id: ${id}`, 2)
  return join(deps.jobsDir, `${id}.json`)
}
export const readJob = (deps: DeployDeps, id: string): Job | null => {
  try {
    return JSON.parse(readFileSync(jobPath(deps, id), 'utf8'))
  } catch {
    return null
  }
}
const writeJob = (deps: DeployDeps, job: Job) => {
  mkdirSync(deps.jobsDir, { recursive: true })
  const path = jobPath(deps, job.id)
  writeFileSync(`${path}.tmp`, `${JSON.stringify(job, null, 2)}\n`)
  renameSync(`${path}.tmp`, path)
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM'
  }
}

/**
 * Called under the kernel lock: recheck the stale owner before moving its pid file aside.
 */
export function takeOver(lock: string, stale: string): boolean {
  if (readFileSafe(lock) !== stale) return false
  const aside = `${lock}.${process.pid}.${randomBytes(4).toString('hex')}`
  try {
    renameSync(lock, aside)
  } catch {
    return false
  }
  rmSync(aside, { force: true })
  return true
}

/** flock keeps stale-lock waiters from renaming a new owner's pid file. EOF also releases it if we die. */
async function kernelLock(path: string): Promise<() => Promise<void>> {
  const child = spawn(
    'flock',
    [
      '-x',
      path,
      process.execPath,
      '-e',
      'process.stdout.write("locked\\n"); process.stdin.resume()',
    ],
    { stdio: ['pipe', 'pipe', 'inherit'] },
  )
  const ended = new Promise<void>((resolve, reject) => {
    child.once('error', reject)
    child.once('close', (code) =>
      code === 0 ? resolve() : reject(new Refusal(`Deploy lock exited ${code}`)),
    )
  })
  await Promise.race([
    new Promise<void>((resolve) => child.stdout.once('data', () => resolve())),
    ended.then(() => {
      throw new Refusal('Deploy lock ended before it was acquired')
    }),
  ])
  return async () => {
    child.stdin.end()
    await ended
  }
}

/**
 * One deploy at a time per host: a lock file created atomically with the owner's pid and a token
 * in it. A dead owner's lock is taken over by rename; `held()` says whether the lock is still ours.
 */
export async function withLock<T>(
  deps: DeployDeps,
  fn: (held: () => boolean) => Promise<T>,
): Promise<T> {
  const lock = join(deps.releasesDir, '.deploy.pid')
  mkdirSync(deps.releasesDir, { recursive: true })
  const unlock = await kernelLock(join(deps.releasesDir, '.deploy.flock'))
  const mine = `${process.pid} ${randomBytes(6).toString('hex')}\n`
  let told = false
  try {
    for (;;) {
      try {
        writeFileSync(lock, mine, { flag: 'wx' })
        break
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
      }
      const held = readFileSafe(lock)
      if (held === null) continue
      const pid = Number(held.split(' ')[0])
      if (!pid || !pidAlive(pid)) {
        takeOver(lock, held)
        continue
      }
      if (!told) deps.out(`[deploy] waiting for the deploy running as pid ${pid}`)
      told = true
      await deps.sleep(2_000)
    }
    cleanStaging(deps)
    return await fn(() => readFileSafe(lock) === mine)
  } finally {
    if (readFileSafe(lock) === mine) rmSync(lock, { force: true })
    await unlock()
  }
}

/** Staging dirs and tars (`.<sha>.<pid>[.tar]`) a dead deploy left behind. */
export function cleanStaging(deps: DeployDeps) {
  if (!existsSync(deps.releasesDir)) return
  for (const name of readdirSync(deps.releasesDir)) {
    const match = /^\.[0-9a-f]{40}\.(\d+)(\.tar)?$/.exec(name)
    if (!match || pidAlive(Number(match[1]))) continue
    rmSync(join(deps.releasesDir, name), { recursive: true, force: true })
    deps.out(`[deploy] removed ${name}, left by a deploy that died`)
  }
}

const readFileSafe = (path: string) => {
  try {
    return readFileSync(path, 'utf8')
  } catch {
    return null
  }
}

function hookBin(env: NodeJS.ProcessEnv): string {
  if (env.AICO_HOOK_BIN) return env.AICO_HOOK_BIN
  for (const dir of (env.PATH ?? '').split(':'))
    if (dir && existsSync(join(dir, 'aico-hook'))) return join(dir, 'aico-hook')
  return join(homedir(), '.local/bin/aico-hook')
}

/** Entry point: refusals print and exit non-zero; a detached request queues and returns. */
export async function deploy(req: DeployRequest, root: string, deps: DeployDeps): Promise<number> {
  const project = loadProject(root)
  if (req.project && !project.names.includes(req.project)) {
    if (deps.env.AICO_OPS_CALLER !== 'st')
      deps.err(
        `aico deploy runs ${project.id} only; ${req.project} deploys with st service rebuild`,
      )
    return NOT_HANDLED
  }
  const git = (args: string[]) => {
    const result = deps.run('git', ['-C', root, ...args])
    if (result.code !== 0) throw new Refusal(`git ${args.join(' ')} failed: ${tail(result, 3)}`)
    return result.out.trim()
  }
  const sha = git(['rev-parse', '--verify', `${req.sha || 'HEAD'}^{commit}`])
  const ack = req.withAck ? ['--with-ack', req.withAck] : []
  /** Another agent's hold refuses the restart (null: none, or none known). */
  const holdRefusal = () => {
    const guard = deps.run(hookBin(deps.env), ['lease', '--guard', 'rebuild', ...ack], {
      cwd: root,
      env: deps.env,
    })
    if (guard.code === 1 && guard.out.trim()) return guard.out.trim()
    if (guard.code !== 0)
      deps.err(
        `[deploy] WARNING other agents' holds are unknown (${tail(guard, 1)}); deploying anyway`,
      )
    return null
  }
  let job: Job | null = null
  if (req.job) {
    job = readJob(deps, req.job)
    if (!job || job.sha !== sha || job.state !== 'queued')
      throw new Refusal(`Deploy job ${req.job} is not queued for ${sha}`)
  } else {
    const refused = holdRefusal()
    if (refused) throw new Refusal(refused, 2)
  }
  const packages = readPackages(git, sha)
  const template = (unit: string) => {
    const result = deps.run('git', ['-C', root, 'show', `${sha}:scripts/systemd/${unit}`])
    return result.code === 0 ? result.out : ''
  }
  const live = (unit: string) => readFileSafe(join(deps.systemdDir, unit))
  const changedCache = new Map<string, boolean>()
  const changed = (unit: string) => {
    if (!changedCache.has(unit)) {
      const from = runningSha(live(unit), deps.releasesDir)
      const diff = from ? deps.run('git', ['-C', root, 'diff', '--name-only', from, sha]) : null
      changedCache.set(
        unit,
        diff?.code !== 0 ||
          touches(
            diff.out.split('\n').filter(Boolean),
            unitSources(project, unit, template(unit), packages),
          ),
      )
    }
    return changedCache.get(unit) as boolean
  }
  const active = (unit: string) =>
    deps.run('systemctl', ['--user', 'is-active', unit], { env: deps.env }).out.trim() === 'active'
  // Refuse a bad combination before queueing anything.
  selectUnits(project, req, { active, changed: () => false })

  if (req.detach) {
    const id = `aico-${randomBytes(6).toString('hex')}`
    const argv = [req.project || project.id, '--sha', sha, '--job', id]
    if (req.scope) argv.push('--scope', req.scope)
    for (const worker of req.workers) argv.push('--worker', worker)
    if (req.includeAllWorkers) argv.push('--include-all-workers')
    if (req.rollback) argv.push('--rollback')
    if (req.withAck) argv.push('--with-ack', req.withAck)
    writeJob(deps, {
      id,
      project: project.id,
      sha,
      state: 'queued',
      argv,
      queued_at: new Date().toISOString(),
    })
    // The job runs as the caller (its identity holds the deploy hold the acceptance guard checks).
    const setenv = ops.deploy.jobEnv
      .filter((name) => deps.env[name])
      .map((name) => `--setenv=${name}=${deps.env[name]}`)
    const queued = deps.run(
      'systemd-run',
      [
        '--user',
        `--unit=aico-deploy-${id}`,
        '--collect',
        '--quiet',
        '--nice=10',
        `--working-directory=${root}`,
        ...setenv,
        process.execPath,
        '--disable-warning=ExperimentalWarning',
        deps.self,
        'deploy',
        ...argv,
      ],
      { env: deps.env },
    )
    if (queued.code !== 0) {
      writeJob(deps, {
        ...(readJob(deps, id) as Job),
        state: 'failed',
        message: 'could not queue',
        finished_at: new Date().toISOString(),
      })
      throw new Refusal(`Could not queue the deploy: ${tail(queued, 3)}`)
    }
    deps.out(`[deploy] queued ${id} for ${sha.slice(0, 12)}`)
    deps.out(
      `[deploy] result: aico deploy result ${id}   wait: aico deploy wait ${id}   log: aico logs aico-deploy-${id}`,
    )
    return 0
  }

  const started = Date.now()
  if (job) {
    job = { ...job, state: 'running' }
    writeJob(deps, job)
  }
  let finished = false
  const finish = async (
    state: 'succeeded' | 'failed',
    message: string,
    units: string[] = [],
    code = state === 'succeeded' ? 0 : 1,
  ) => {
    if (job)
      writeJob(deps, {
        ...job,
        state,
        message,
        units,
        exit_code: code,
        finished_at: new Date().toISOString(),
      })
    await deps.report(
      {
        id: `deploy:${project.id}`,
        what: `${project.id} deploy`,
        kind: 'service',
        machine: machineId(),
        project: project.id,
        state: state === 'succeeded' ? 'ok' : 'failed',
        meaning: message.slice(0, 300),
        last_run: new Date().toISOString(),
      },
      project.port,
    )
    finished = true
  }
  try {
    deps.out(`[deploy] ${project.id} at ${sha.slice(0, 12)}: accepting that commit`)
    const aico = deps.env.AICO_BIN || 'aico'
    const accepted = deps.run(aico, ['check', '--acceptance', '--sha', sha, ...ack], {
      cwd: root,
      env: deps.env,
      inherit: true,
    })
    if (accepted.code !== 0) {
      throw new Refusal(
        `Acceptance of ${sha.slice(0, 12)} failed; nothing was deployed.`,
        accepted.code,
      )
    }
    return await withLock(deps, async (held) => {
      if (existsSync(journalPath(deps))) {
        const refused = holdRefusal()
        if (refused) throw new Refusal(refused, 2)
        recoverSwap(deps)
      }
      const selection = selectUnits(project, req, { active, changed })
      for (const unit of selection.stale)
        if (!selection.restart.includes(unit))
          deps.out(
            `[deploy] ${unit} changed since its release and was left running; deploy it with: aico deploy ${project.id} --worker ${unit.replace(/\.service$/, '')}`,
          )
      // Never put an older commit over a newer one another builder deployed meanwhile.
      const restart: string[] = []
      for (const unit of selection.restart) {
        const from = runningSha(live(unit), deps.releasesDir)
        if (
          !from ||
          from === sha ||
          req.rollback ||
          deps.run('git', ['-C', root, 'merge-base', '--is-ancestor', from, sha]).code === 0
        )
          restart.push(unit)
        else if (deps.run('git', ['-C', root, 'merge-base', '--is-ancestor', sha, from]).code === 0)
          deps.out(
            `[deploy] ${unit} already runs ${from.slice(0, 12)}, which contains ${sha.slice(0, 12)}; left as is`,
          )
        else {
          await finish(
            'failed',
            `Deploy of ${sha.slice(0, 10)} refused: ${unit} runs ${from.slice(0, 10)}, not an ancestor`,
          )
          throw new Refusal(
            `${unit} runs ${from.slice(0, 12)}, which ${sha.slice(0, 12)} does not contain; deploy a newer commit or pass --rollback.`,
          )
        }
      }
      // The ops bundle `aico deploy` runs: installed from this commit when its sources changed.
      const installedOps = installedOpsSha(deps)
      const installOps =
        packages.some((pkg) => pkg.dir === 'ops') &&
        (!installedOps ||
          (installedOps !== sha &&
            (req.rollback ||
              deps.run('git', ['-C', root, 'merge-base', '--is-ancestor', installedOps, sha])
                .code === 0) &&
            (() => {
              const diff = deps.run('git', ['-C', root, 'diff', '--name-only', installedOps, sha])
              return (
                diff.code !== 0 ||
                touches(diff.out.split('\n').filter(Boolean), [
                  ...ops.deploy.rootSources,
                  ...cone(packages, 'ops'),
                ])
              )
            })()))
      if (!restart.length && !installOps) {
        const message = `Nothing to restart at ${sha.slice(0, 10)}: no unit's sources changed`
        deps.out(`[deploy] ${message.toLowerCase()}`)
        await finish('succeeded', message)
        return 0
      }
      if (restart.length) deps.out(`[deploy] restarting ${restart.join(', ')}`)
      let release: string
      try {
        release = prepareRelease(
          root,
          sha,
          [
            ...new Set([
              ...restart.flatMap((unit) => unitBuilds(unit, template(unit))),
              ...(installOps ? ['ops'] : []),
            ]),
          ],
          deps,
        )
      } catch (error) {
        await finish(
          'failed',
          `Deploy of ${sha.slice(0, 10)} failed: ${(error as Error).message.split('\n')[0]}`,
        )
        throw error
      }
      if (restart.length) {
        // A hold taken while this deploy waited (queued, or behind another deploy) still refuses it.
        const refused = holdRefusal()
        if (refused) {
          await finish('failed', `Deploy of ${sha.slice(0, 10)} refused: ${refused}`, [], 2)
          throw new Refusal(refused, 2)
        }
        if (!held()) {
          await finish('failed', `Deploy of ${sha.slice(0, 10)} lost the deploy lock`)
          throw new Refusal('Another deploy took the deploy lock; nothing was restarted.')
        }
        const failed = await swapUnits(project, restart, release, sha, deps)
        if (failed) {
          await finish(
            'failed',
            `Deploy of ${sha.slice(0, 10)} failed (${failed.failure}); ${failed.outcome}`,
            restart,
          )
          throw new Refusal(`Deploy failed: ${failed.failure}. ${capital(failed.outcome)}.`)
        }
      }
      if (installOps) installOpsBundle(deps, release)
      const seconds = Math.round((Date.now() - started) / 1000)
      pruneReleases(deps, release)
      const what = restart.length
        ? restart.map((unit) => unit.replace(/\.service$/, '')).join(', ')
        : 'the deploy code only'
      const message = `Deployed ${sha.slice(0, 10)}: ${what} (${seconds} s)`
      deps.out(`[deploy] ${message}`)
      await finish('succeeded', message, restart)
      finished = true
      return 0
    })
  } catch (error) {
    if (!finished)
      await finish(
        'failed',
        (error as Error).message,
        [],
        error instanceof Refusal ? error.code : 1,
      )
    throw error
  }
}

/** Export the commit, install, and build the packages the units need; an existing release is reused. */
export function prepareRelease(
  root: string,
  sha: string,
  builds: string[],
  deps: DeployDeps,
): string {
  const dir = join(deps.releasesDir, sha)
  const marker = join(dir, '.aico-release.json')
  const step = (what: string, cmd: string, args: string[], cwd: string) => {
    deps.out(`[deploy] ${what}`)
    const result = deps.run('nice', ['-n', '10', cmd, ...args], { cwd, env: deps.env })
    if (result.code !== 0) throw new Refusal(`${what} failed:\n${tail(result)}`)
  }
  if (!existsSync(marker)) {
    const staging = join(deps.releasesDir, `.${sha}.${process.pid}`)
    rmSync(staging, { recursive: true, force: true })
    rmSync(dir, { recursive: true, force: true })
    mkdirSync(staging, { recursive: true })
    try {
      const archive = deps.run('git', [
        '-C',
        root,
        'archive',
        '--format=tar',
        '-o',
        `${staging}.tar`,
        sha,
      ])
      if (archive.code !== 0) throw new Refusal(`git archive ${sha} failed: ${tail(archive, 3)}`)
      const unpack = deps.run('tar', ['-xf', `${staging}.tar`, '-C', staging])
      if (unpack.code !== 0) throw new Refusal(`unpacking ${sha} failed: ${tail(unpack, 3)}`)
      step(
        'installing dependencies',
        'npm',
        ['ci', '--no-audit', '--no-fund', '--prefer-offline'],
        staging,
      )
      writeFileSync(join(staging, '.aico-release.json'), `${JSON.stringify({ sha, built: [] })}\n`)
      renameSync(staging, dir)
    } catch (error) {
      rmSync(staging, { recursive: true, force: true })
      throw error
    } finally {
      rmSync(`${staging}.tar`, { force: true })
    }
  }
  const state = JSON.parse(readFileSync(marker, 'utf8')) as { sha: string; built: string[] }
  for (const pkg of builds) {
    if (state.built.includes(pkg)) continue
    const manifest = JSON.parse(readFileSafe(join(dir, 'packages', pkg, 'package.json')) ?? '{}')
    if (manifest.scripts?.build) {
      if (pkg === 'web-frontend') seedNextCache(dir, deps)
      step(`building ${pkg}`, 'npm', ['run', 'build', '-w', `packages/${pkg}`], dir)
    }
    state.built.push(pkg)
    writeFileSync(marker, `${JSON.stringify(state)}\n`)
  }
  return dir
}

/** Next's build cache is content-addressed: the newest other release's cache only skips unchanged work. */
function seedNextCache(dir: string, deps: DeployDeps) {
  const target = join(dir, 'packages/web-frontend/.next/cache')
  if (existsSync(target)) return
  const donor = releases(deps)
    .map((name) => join(deps.releasesDir, name, 'packages/web-frontend/.next/cache'))
    .find((path) => path !== target && existsSync(path))
  if (!donor) return
  mkdirSync(join(dir, 'packages/web-frontend/.next'), { recursive: true })
  deps.run('cp', ['-a', '--reflink=auto', donor, target])
}

const releases = (deps: DeployDeps) =>
  existsSync(deps.releasesDir)
    ? readdirSync(deps.releasesDir)
        .filter((name) => /^[0-9a-f]{40}$/.test(name))
        .sort(
          (a, b) =>
            statSync(join(deps.releasesDir, b)).mtimeMs -
            statSync(join(deps.releasesDir, a)).mtimeMs,
        )
    : []

const capital = (text: string) => text.charAt(0).toUpperCase() + text.slice(1)

// ---- the unit swap and its journal -----------------------------------------------------------

interface SwapJournal {
  sha: string
  started_at: string
  /** Each unit's file before the swap (null: there was none). */
  previous: Record<string, string | null>
}

const journalPath = (deps: DeployDeps) => join(deps.releasesDir, '.swap.json')

/** Put back unit files as they were and restart them; null when every step worked, else what failed. */
function restoreUnits(previous: Record<string, string | null>, deps: DeployDeps): string | null {
  const systemctl = (...args: string[]) =>
    deps.run('systemctl', ['--user', ...args], { env: deps.env })
  const problems: string[] = []
  for (const [unit, text] of Object.entries(previous))
    try {
      if (text === null) {
        const stopped = systemctl('stop', unit)
        if (stopped.code !== 0) problems.push(`${unit} did not stop: ${tail(stopped, 1)}`)
        rmSync(join(deps.systemdDir, unit), { force: true })
      } else writeFileSync(join(deps.systemdDir, unit), text)
    } catch (error) {
      problems.push(`${unit} not written back: ${(error as Error).message}`)
    }
  const reload = systemctl('daemon-reload')
  if (reload.code !== 0) problems.push(`daemon-reload: ${tail(reload, 1)}`)
  for (const [unit, text] of Object.entries(previous)) {
    if (text === null) continue
    const restarted = systemctl('restart', unit)
    if (restarted.code !== 0) problems.push(`${unit} did not restart: ${tail(restarted, 1)}`)
  }
  return problems.length ? problems.join('; ') : null
}

/** A swap a killed deploy left unfinished: its units go back to what they ran before it. */
export function recoverSwap(deps: DeployDeps) {
  const text = readFileSafe(journalPath(deps))
  if (text === null) return
  let journal: SwapJournal
  try {
    journal = JSON.parse(text)
  } catch {
    throw new Refusal('The unfinished deploy journal is unreadable; no units were changed')
  }
  const units = Object.keys(journal.previous)
  deps.out(
    `[deploy] the deploy of ${String(journal.sha).slice(0, 12)} stopped mid-swap; putting back ${units.join(', ')}`,
  )
  const problem = restoreUnits(journal.previous, deps)
  if (problem) throw new Refusal(`Putting the previous units back failed: ${problem}`)
  rmSync(journalPath(deps), { force: true })
}

/**
 * Render, restart and check each unit; on any failure put the previous unit files back. A journal
 * holds the previous files until the swap ends, so a deploy killed midway is undone by the next one.
 */
async function swapUnits(
  project: Project,
  units: string[],
  release: string,
  sha: string,
  deps: DeployDeps,
): Promise<{ failure: string; outcome: string } | null> {
  const systemctl = (...args: string[]) =>
    deps.run('systemctl', ['--user', ...args], { env: deps.env })
  const rendered = new Map<string, string>()
  for (const unit of units) {
    const template = readFileSafe(join(release, 'scripts/systemd', unit))
    if (template === null)
      return {
        failure: `${unit} has no template in scripts/systemd`,
        outcome: 'nothing was changed',
      }
    rendered.set(unit, template.replaceAll('__PROJECT_ROOT__', release))
  }
  const previous: Record<string, string | null> = {}
  for (const unit of units) previous[unit] = readFileSafe(join(deps.systemdDir, unit))
  mkdirSync(deps.systemdDir, { recursive: true })
  const journal: SwapJournal = { sha, started_at: new Date().toISOString(), previous }
  writeFileSync(`${journalPath(deps)}.tmp`, JSON.stringify(journal))
  renameSync(`${journalPath(deps)}.tmp`, journalPath(deps))
  const fail = (failure: string) => {
    const problem = restoreUnits(previous, deps)
    if (!problem) rmSync(journalPath(deps), { force: true })
    return {
      failure,
      outcome: problem
        ? `putting the previous units back failed too (${problem})`
        : 'the previous unit files were restored and restarted',
    }
  }
  for (const [unit, text] of rendered) writeFileSync(join(deps.systemdDir, unit), text)
  if (systemctl('daemon-reload').code !== 0) return fail('systemctl daemon-reload failed')
  const boot = units.filter(
    (unit) =>
      !project.optionalWorkers.includes(unit) && /^\[Install\]/m.test(rendered.get(unit) ?? ''),
  )
  if (boot.length) systemctl('enable', ...boot)
  for (const unit of units) {
    deps.out(`[deploy] restarting ${unit}`)
    const restarted = systemctl('restart', unit)
    if (restarted.code !== 0) return fail(`${unit} did not restart: ${tail(restarted, 2)}`)
  }
  const attempts = ops.deploy.healthAttempts
  if (units.includes(project.backend) && project.port) {
    for (const path of [project.health, '/']) {
      let status = 0
      for (let i = 0; i < attempts && !(status >= 200 && status < 400); i++) {
        if (i) await deps.sleep(1_000)
        status = await deps.probe(`http://127.0.0.1:${project.port}${path}`)
      }
      deps.out(`[deploy] ${project.backend} ${path}: ${status || 'no answer'}`)
      if (!(status >= 200 && status < 400))
        return fail(`${project.backend} ${path} answered ${status || 'nothing'}`)
    }
  }
  for (const unit of units) {
    const state = systemctl('is-active', unit).out.trim()
    deps.out(`[deploy] ${unit}: ${state}`)
    if (state !== 'active') return fail(`${unit} is ${state}`)
  }
  rmSync(journalPath(deps), { force: true })
  return null
}

// ---- the installed ops bundle ----------------------------------------------------------------

const opsBundle = (release: string) => join(release, 'packages/ops/dist/aico-ops.mjs')

/** The release commit whose ops bundle `aico deploy` runs, or null before the first install. */
export function installedOpsSha(deps: DeployDeps): string | null {
  try {
    const target = realpathSync(deps.opsLink)
    return runningSha(`WorkingDirectory=${target}\n`, realpathSync(deps.releasesDir))
  } catch {
    return null
  }
}

/** Point the link at this release's ops bundle (atomically: a new link renamed over the old). */
export function installOpsBundle(deps: DeployDeps, release: string) {
  if (!existsSync(opsBundle(release)))
    throw new Refusal(`The release has no ops bundle at ${opsBundle(release)}`)
  const temporary = `${deps.opsLink}.${process.pid}.tmp`
  rmSync(temporary, { force: true })
  mkdirSync(join(deps.opsLink, '..'), { recursive: true })
  symlinkSync(release, temporary)
  renameSync(temporary, deps.opsLink)
  deps.out(`[deploy] aico deploy now runs from ${release.split('/').at(-1)?.slice(0, 12)}`)
}

/** Keep the newest releases and every one a unit file still runs; the rest are rebuildable. */
export function pruneReleases(deps: DeployDeps, current: string) {
  const units = existsSync(deps.systemdDir)
    ? readdirSync(deps.systemdDir)
        .map((name) => readFileSafe(join(deps.systemdDir, name)) ?? '')
        .join('\n')
    : ''
  for (const [index, name] of releases(deps).entries()) {
    const path = join(deps.releasesDir, name)
    if (
      index < ops.deploy.keepReleases ||
      path === current ||
      units.includes(`${path}/`) ||
      installedOpsSha(deps) === name
    )
      continue
    rmSync(path, { recursive: true, force: true })
    deps.out(`[deploy] removed release ${name.slice(0, 12)}`)
  }
}

/**
 * `aico deploy result|wait ID`: the job's state. Exits as `st service wait` does: 0 succeeded, the
 * deploy's own exit code when it failed, 1 while it is still queued or running.
 */
export async function jobResult(
  id: string,
  wait: boolean,
  deps: DeployDeps,
  timeoutSec = 1800,
): Promise<number> {
  const deadline = Date.now() + timeoutSec * 1000
  for (;;) {
    let job = readJob(deps, id)
    if (!job) throw new Refusal(`No deploy job ${id}`)
    if (job.state === 'queued' || job.state === 'running') {
      const unit = deps
        .run('systemctl', ['--user', 'is-active', `aico-deploy-${id}.service`], { env: deps.env })
        .out.trim()
      if (
        !['active', 'activating'].includes(unit) &&
        (readJob(deps, id) as Job).state === job.state
      ) {
        job = {
          ...job,
          state: 'failed',
          message: `the deploy unit ended (${unit || 'gone'}) without a result`,
          exit_code: 1,
          finished_at: new Date().toISOString(),
        }
        writeJob(deps, job)
      }
    }
    if (job.state === 'succeeded' || job.state === 'failed' || !wait || Date.now() > deadline) {
      deps.out(
        `${job.id} ${job.state} ${job.sha.slice(0, 12)}${job.message ? `: ${job.message}` : ''}`,
      )
      if (job.state === 'succeeded') return 0
      return job.state === 'failed' ? job.exit_code || 1 : 1
    }
    await deps.sleep(2_000)
  }
}
