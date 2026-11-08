// `aico deploy [PROJECT]`: puts one commit live. It takes the commit HEAD names when it starts (or
// --sha), accepts that exact commit (`aico check --acceptance --sha`, in a worktree of it), exports
// it into ~/.local/lib/aico/releases/<sha>, builds there and restarts only the units whose package
// cone changed since the commit each one runs. A server that serves its frontend build from a link
// (`deploy.frontends`) keeps running when only that build changed: the link moves to the new one.
// Other builders may commit meanwhile: nothing reads the checkout after the start, so HEAD moving
// never fails or changes the deploy.
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
  linkSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { machineId, postStatusRows } from '@aico/status'
import ops from '../data/ops.json' with { type: 'json' }
import {
  hookInstallWanted,
  installedOpsSha,
  installHook,
  installOpsBundle,
  installRootSources,
  opsInstallWanted,
  restoreOps,
  rootInstallWanted,
} from './deploy-install'
import { type DeployConfig, type DeployDeps, Refusal, runningSha, touches } from './deploy-model'
import { expandHome, run as realRun, tail } from './sh'

export * from './deploy-install'
export * from './deploy-model'

/** st's seam treats this exit as "Aico does not deploy that; run SummitFlow's own code". */
export const NOT_HANDLED = 3

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
  /** Where it runs when not on this machine, from runtime.deployment. */
  deployment?: ProjectDeployment
}

export interface ProjectDeployment {
  ssh_host: string
  vmid: number
  guest_type?: 'qemu' | 'lxc'
  manager?: 'user' | 'system'
  user?: string
  uid?: number
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
    ...(runtime.deployment ? { deployment: runtime.deployment } : {}),
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
  /** Manual workers a deploy restarts because they run changed code or are behind the release. */
  auto: string[]
  /** Manual workers whose sources changed, left running (a frontend-only or single-unit scope). */
  stale: string[]
}

export interface SelectContext {
  active(unit: string): boolean
  changed(unit: string): boolean
  /** The running daemon speaks an older API than this release (Tether's /v1/version). */
  behind?(unit: string): boolean
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
  if (manual.length) return { restart: [...new Set(manual)], auto: [], stale: [] }

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
  // A manual worker still restarts when the release changes what it runs or its contract with the
  // units being restarted (a web server sending fields an older daemon rejects); a frontend-only
  // or single-unit scope leaves it alone.
  const wholeRelease = !scope || ['full', 'backend', 'worker'].includes(scope)
  const behind = (unit: string) => ctx.changed(unit) || ctx.behind?.(unit) === true
  const auto = wholeRelease ? project.manualWorkers.filter(behind) : []
  const stale = project.manualWorkers.filter((unit) => !auto.includes(unit) && ctx.changed(unit))
  return { restart: [...restart, ...auto], auto, stale }
}

// ---- package cones -------------------------------------------------------------------------

/**
 * The deploy data (unit sources, root and CLI sources, the root install) of the commit being
 * deployed: a deploy runs the previously installed bundle, and its selection should follow the
 * commit's own data, not the data bundled into the older code. Falls back to the bundled copy.
 */
export function deployConfig(git: (args: string[]) => string, sha: string): DeployConfig {
  try {
    const target = JSON.parse(git(['show', `${sha}:packages/ops/data/ops.json`])).deploy
    if (target && typeof target === 'object') return { ...ops.deploy, ...target }
  } catch {}
  return ops.deploy
}

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
  cfg: DeployConfig = ops.deploy,
): string[] {
  const extra: string[] = (cfg.unitSources as Record<string, string[]>)[unit] ?? []
  const pkg = unitPackage(template)
  const sources = [
    `scripts/systemd/${unit}`,
    ...cfg.rootSources,
    ...(pkg ? cone(packages, pkg) : []),
    ...extra.flatMap((path) =>
      path.startsWith('packages/') ? cone(packages, path.slice(9)) : [path],
    ),
    ...(project.manualSources[unit] ?? []),
  ]
  return [...new Set(sources)]
}

/** The packages a unit needs built in the release: its own and the extra package sources. */
export function unitBuilds(
  unit: string,
  template: string,
  cfg: DeployConfig = ops.deploy,
): string[] {
  const extra: string[] = (cfg.unitSources as Record<string, string[]>)[unit] ?? []
  const pkg = unitPackage(template)
  return [
    ...(pkg ? [pkg] : []),
    ...extra.filter((p) => p.startsWith('packages/')).map((p) => p.slice(9)),
  ]
}

// ---- the run -------------------------------------------------------------------------------

/** cwd, exe, command line, open files and mapped files of every live process, read from /proc. */
export function procPaths(procDir = '/proc'): string[] {
  const found: string[] = []
  let pids: string[] = []
  try {
    pids = readdirSync(procDir).filter((name) => /^\d+$/.test(name))
  } catch {}
  for (const pid of pids) {
    for (const link of ['cwd', 'exe']) {
      try {
        found.push(readlinkSync(join(procDir, pid, link)))
      } catch {}
    }
    const cmdline = readFileSafe(join(procDir, pid, 'cmdline'))
    if (cmdline) found.push(cmdline.replaceAll('\0', ' '))
    try {
      for (const fd of readdirSync(join(procDir, pid, 'fd')))
        try {
          found.push(readlinkSync(join(procDir, pid, 'fd', fd)))
        } catch {}
    } catch {}
    const maps = readFileSafe(join(procDir, pid, 'maps'))
    if (maps) found.push(maps)
  }
  return found
}

function userBusEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const runtime = env.XDG_RUNTIME_DIR || `/run/user/${process.getuid?.() ?? 0}`
  return {
    ...env,
    XDG_RUNTIME_DIR: runtime,
    DBUS_SESSION_BUS_ADDRESS: env.DBUS_SESSION_BUS_ADDRESS || `unix:path=${runtime}/bus`,
  }
}

export function defaultDeps(env: NodeJS.ProcessEnv = process.env): DeployDeps {
  env = userBusEnv(env)
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
        await postStatusRows(base, [row], { timeoutMs: 3_000 })
      } catch {}
    },
    self: process.argv[1] ?? '',
    opsLink: expandHome(env.AICO_OPS_INSTALLED || ops.deploy.installedOps),
    processPaths: () => procPaths(),
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
  /** Units whose frontend build this deploy swapped without restarting them. */
  frontends?: string[]
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
/** Which stages failed, and their failing lines, so the refusal needs no trip to the log. */
export function acceptanceFailures(output: string, max = 16): string[] {
  const kept: string[] = []
  let inFailure = false
  for (const line of output.split('\n')) {
    if (line.startsWith('CHECK:FAIL:')) inFailure = true
    else if (!line.startsWith('  ')) inFailure = false
    if (inFailure) kept.push(line)
  }
  return kept.length > max ? [...kept.slice(0, max), `${kept.length - max} more in the log`] : kept
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
  const cfg = deployConfig(git, sha)
  const template = (unit: string) => {
    const result = deps.run('git', ['-C', root, 'show', `${sha}:scripts/systemd/${unit}`])
    return result.code === 0 ? result.out : ''
  }
  const live = (unit: string) => readFileSafe(join(deps.systemdDir, unit))
  const changedSince = (from: string | null, sources: string[]) => {
    const diff = from ? deps.run('git', ['-C', root, 'diff', '--name-only', from, sha]) : null
    return diff?.code !== 0 || touches(diff.out.split('\n').filter(Boolean), sources)
  }
  /** The unit serves its frontend build from the link, now and in this commit: a new build swaps in. */
  const swappable = (unit: string) => {
    const spec = frontendSpec(cfg, unit)
    return !!spec && servesLink(live(unit), spec) && servesLink(template(unit), spec)
  }
  /** What the unit runs; a swappable unit's frontend package is served, not run. */
  const runs = (unit: string) => {
    const spec = frontendSpec(cfg, unit)
    if (!spec || !swappable(unit)) return unitSources(project, unit, template(unit), packages, cfg)
    const sources = cfg.unitSources as Record<string, string[]>
    const extra = (sources[unit] ?? []).filter((path) => path !== `packages/${spec.package}`)
    return unitSources(project, unit, template(unit), packages, {
      ...cfg,
      unitSources: { ...sources, [unit]: extra } as DeployConfig['unitSources'],
    })
  }
  const changedCache = new Map<string, boolean>()
  const changed = (unit: string) => {
    if (!changedCache.has(unit))
      changedCache.set(unit, changedSince(runningSha(live(unit), deps.releasesDir), runs(unit)))
    return changedCache.get(unit) as boolean
  }
  /** The release whose frontend build the unit serves: the link's, else the unit's own. */
  const servedFrom = (unit: string) =>
    servedFrontendSha(frontendSpec(cfg, unit) as FrontendSpec, deps) ??
    runningSha(live(unit), deps.releasesDir)
  const frontendChanged = (unit: string) =>
    changedSince(servedFrom(unit), [
      ...cfg.rootSources,
      ...cone(packages, (frontendSpec(cfg, unit) as FrontendSpec).package),
    ])
  const isAncestor = (a: string, b: string) =>
    deps.run('git', ['-C', root, 'merge-base', '--is-ancestor', a, b]).code === 0
  /** Whether this commit may replace what runs from `from`: never an older one over a newer one. */
  const order = (from: string | null) =>
    !from || from === sha || req.rollback || isAncestor(from, sha)
      ? 'go'
      : isAncestor(sha, from)
        ? 'newer'
        : 'diverged'
  const active = (unit: string) =>
    deps.run('systemctl', ['--user', 'is-active', unit], { env: deps.env }).out.trim() === 'active'
  const behindCache = new Map<string, boolean>()
  const behind = (unit: string) => {
    if (!behindCache.has(unit)) {
      const config = deps.run('git', ['-C', root, 'show', `${sha}:packages/tether/src/config.ts`])
      behindCache.set(unit, config.code === 0 && daemonBehind(deps, unit, config.out))
    }
    return behindCache.get(unit) as boolean
  }
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
  let swapped: string[] = []
  const finish = async (
    state: 'succeeded' | 'failed',
    message: string,
    units: string[] = [],
    code = state === 'succeeded' ? 0 : 1,
    // A refusal changed nothing: the old release still serves and the deploying agent sees it.
    // warn keeps it on the Status screen without raising an owner ask the way failed does.
    refused = false,
  ) => {
    if (job)
      writeJob(deps, {
        ...job,
        state,
        message,
        units,
        ...(swapped.length ? { frontends: swapped } : {}),
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
        state: state === 'succeeded' ? 'ok' : refused ? 'warn' : 'failed',
        meaning: message.replace(/\n\s*/g, ' ').slice(0, 300),
        last_run: new Date().toISOString(),
      },
      project.port,
    )
    finished = true
  }
  // Records the failed deploy's Status (message, the units it did restart), then throws `error`.
  // Only a Refusal marked unchanged shows as a refusal: a failed swap recovery or build is a real failure.
  const fail = async (message: string, error: Error, units: string[] = []): Promise<never> => {
    await finish(
      'failed',
      message,
      units,
      error instanceof Refusal ? error.code : 1,
      error instanceof Refusal && error.unchanged,
    )
    throw error
  }
  try {
    deps.out(`[deploy] ${project.id} at ${sha.slice(0, 12)}: accepting that commit`)
    const aico = deps.env.AICO_BIN || 'aico'
    const accepted = deps.run(aico, ['check', '--acceptance', '--sha', sha, ...ack], {
      cwd: root,
      env: deps.env,
      tee: true,
    })
    if (accepted.code !== 0) {
      throw new Refusal(
        [
          `Acceptance of ${sha.slice(0, 12)} failed; nothing was deployed.`,
          ...acceptanceFailures(accepted.out),
        ].join('\n'),
        accepted.code,
        true,
      )
    }
    return await withLock(deps, async (held) => {
      if (existsSync(journalPath(deps))) {
        const refused = holdRefusal()
        if (refused) throw new Refusal(refused, 2, true)
        recoverSwap(deps)
      }
      const selection = selectUnits(project, req, { active, changed, behind })
      for (const unit of selection.auto)
        deps.out(`[deploy] ${unit} restarts: ${manualReason(changed(unit), behind(unit))}`)
      for (const unit of project.manualWorkers)
        if (!selection.restart.includes(unit) && !selection.stale.includes(unit))
          deps.out(`[deploy] ${unit} left running: nothing it runs changed`)
      for (const unit of selection.stale)
        if (!selection.restart.includes(unit))
          deps.out(
            `[deploy] ${unit} changed since its release and was left running; deploy it with: aico deploy ${project.id} --worker ${unit.replace(/\.service$/, '')}`,
          )
      // A frontend-only scope swaps the build of a server that serves it from its link.
      const frontendOnly = req.scope === 'frontend' && swappable(project.backend)
      const selected = selection.restart.filter(
        (unit) => !(frontendOnly && unit === project.backend),
      )
      // Never put an older commit over a newer one another builder deployed meanwhile.
      const placed = async (unit: string, from: string | null, what: string) => {
        const verdict = order(from)
        if (verdict === 'go') return true
        if (verdict === 'newer')
          deps.out(
            `[deploy] ${unit} already ${what} ${from?.slice(0, 12)}, which contains ${sha.slice(0, 12)}; left as is`,
          )
        else {
          await fail(
            `Deploy of ${sha.slice(0, 10)} refused: ${unit} ${what} ${from?.slice(0, 10)}, not an ancestor`,
            new Refusal(
              `${unit} ${what} ${from?.slice(0, 12)}, which ${sha.slice(0, 12)} does not contain; deploy a newer commit or pass --rollback.`,
              1,
              true,
            ),
          )
        }
        return false
      }
      const restart: string[] = []
      for (const unit of selected)
        if (await placed(unit, runningSha(live(unit), deps.releasesDir), 'runs')) restart.push(unit)
      // A server left running whose frontend build changed gets the new build without a restart.
      const manualDeploy = req.workers.some((unit) =>
        project.manualWorkers.includes(canonical(unit)),
      )
      const swaps: string[] = []
      if (!manualDeploy && (!req.scope || req.scope === 'full' || req.scope === 'frontend'))
        for (const unit of [
          project.backend,
          ...project.defaultWorkers,
          ...project.optionalWorkers.filter((unit) => req.includeAllWorkers || active(unit)),
        ]) {
          if (!unit || selected.includes(unit) || !swappable(unit)) continue
          if (selection.restart.includes(unit) && !frontendOnly) continue
          const from = servedFrom(unit)
          if (from === sha || !(frontendOnly || frontendChanged(unit))) continue
          if (await placed(unit, from, 'serves the page from')) swaps.push(unit)
        }
      // The ops bundle `aico deploy` runs: installed from this commit when its sources changed.
      const installOps =
        packages.some((pkg) => pkg.dir === 'ops') &&
        opsInstallWanted(
          root,
          sha,
          [...cfg.rootSources, ...cone(packages, 'ops'), ...cfg.cliSources],
          req.rollback,
          deps,
        )
      const installRoot = rootInstallWanted(root, sha, cfg, req.rollback, deps)
      const hookTree = hookInstallWanted(root, sha, cfg, req.rollback, deps)
      if (!restart.length && !swaps.length && !installOps && !installRoot && !hookTree) {
        const message = `Nothing to restart at ${sha.slice(0, 10)}: no unit's sources changed`
        deps.out(`[deploy] ${message.toLowerCase()}`)
        await finish('succeeded', message)
        return 0
      }
      // What an install after the swap reports: the units are already live, so say so.
      const installed = async (what: string, problem: string | null) => {
        if (!problem) return
        const done = restart.length ? `${restart.join(', ')} deployed; ` : ''
        await fail(
          `Deploy of ${sha.slice(0, 10)}: ${done}the ${what} failed (${problem})`,
          new Refusal(`The ${what} failed: ${problem}`),
          restart,
        )
      }
      if (restart.length) deps.out(`[deploy] restarting ${restart.join(', ')}`)
      if (swaps.length)
        deps.out(`[deploy] new page build for ${swaps.join(', ')}, which keep running`)
      let release: string | null = null
      if (restart.length || swaps.length || installOps)
        try {
          release = prepareRelease(
            root,
            sha,
            [
              ...new Set([
                ...restart.flatMap((unit) => unitBuilds(unit, template(unit), cfg)),
                ...swaps.map((unit) => (frontendSpec(cfg, unit) as FrontendSpec).package),
                ...(installOps
                  ? ['ops', ...(packages.some((pkg) => pkg.dir === 'cli') ? ['cli'] : [])]
                  : []),
              ]),
            ],
            deps,
            {
              packages: peerPackages(project, packages, cfg, template),
              workspace: packages,
              cfg,
            },
          )
        } catch (error) {
          await fail(
            `Deploy of ${sha.slice(0, 10)} failed: ${(error as Error).message.split('\n')[0]}`,
            error as Error,
          )
        }
      if (restart.length || swaps.length || installRoot || hookTree) {
        // A hold taken while this deploy waited (queued, or behind another deploy) still refuses it.
        const refused = holdRefusal()
        if (refused)
          await fail(
            `Deploy of ${sha.slice(0, 10)} refused: ${refused}`,
            new Refusal(refused, 2, true),
          )
        if (!held())
          await fail(
            `Deploy of ${sha.slice(0, 10)} lost the deploy lock`,
            new Refusal('Another deploy took the deploy lock; nothing was restarted.', 1, true),
          )
      }
      if (restart.length && release) {
        const failed = await swapUnits(project, restart, release, sha, deps, installOps, cfg)
        if (failed) {
          await fail(
            `Deploy of ${sha.slice(0, 10)} failed (${failed.failure}); ${failed.outcome}`,
            new Refusal(`Deploy failed: ${failed.failure}. ${capital(failed.outcome)}.`),
            restart,
          )
        }
      }
      if (swaps.length && release) {
        const failed = await swapFrontends(project, swaps, release, cfg, deps)
        if (failed) {
          await fail(
            `Deploy of ${sha.slice(0, 10)} failed (${failed.failure}); ${failed.outcome}`,
            new Refusal(`Deploy failed: ${failed.failure}. ${capital(failed.outcome)}.`),
            restart,
          )
        }
        swapped = swaps
      }
      if (installOps && !restart.length && release) installOpsBundle(deps, release)
      if (installRoot)
        await installed('host-steward root install', installRootSources(root, sha, cfg, deps))
      if (release) {
        // The newest accepted release: the one a peer is sent (scripts/peer-release.sh).
        writeFileSync(join(deps.releasesDir, ACCEPTED), `${sha}\n`)
        pruneReleases(deps, release, cfg)
      }
      // Last: the release is live and accepted whether or not this machine can build the hook.
      if (hookTree)
        await installed('aico-hook install', installHook(root, sha, hookTree, cfg, deps))
      const seconds = Math.round((Date.now() - started) / 1000)
      const parts = [
        ...restart.map((unit) => unit.replace(/\.service$/, '')),
        ...swaps.map((unit) => `the ${unit.replace(/\.service$/, '')} page (no restart)`),
        ...(installRoot ? ['the host-steward root install'] : []),
        ...(hookTree ? ['aico-hook'] : []),
      ]
      const what = parts.length ? parts.join(', ') : 'the deploy code only'
      const message = `Deployed ${sha.slice(0, 10)}: ${what} (${seconds} s)`
      deps.out(`[deploy] ${message}`)
      await finish('succeeded', message, restart)
      finished = true
      return 0
    })
  } catch (error) {
    if (!finished) await fail((error as Error).message, error as Error)
    throw error
  }
}

/** In the releases folder: the commit of the newest accepted deploy's release. */
export const ACCEPTED = '.accepted'

/** What a release must hold built so a peer can run it: the packages, the workspace and the config. */
export interface Completion {
  packages: string[]
  workspace: Pkg[]
  cfg: DeployConfig
}

/**
 * The packages a standalone peer runs from one release: what the deploy's units run (the backend and
 * default workers, with the frontend a unit serves) and the ops and CLI bundles. Tether is the peer's own.
 */
export function peerPackages(
  project: Project,
  workspace: Pkg[],
  cfg: DeployConfig,
  template: (unit: string) => string,
): string[] {
  const has = (dir: string) => workspace.some((pkg) => pkg.dir === dir)
  return [
    ...new Set([
      ...[project.backend, ...project.defaultWorkers]
        .filter(Boolean)
        .flatMap((unit) => unitBuilds(unit, template(unit), cfg)),
      ...Object.values(cfg.frontends as Record<string, FrontendSpec>).map((spec) => spec.package),
      ...['ops', 'cli'],
    ]),
  ].filter(has)
}

/** A release folder's build marker (`.aico-release.json`), or null when unreadable. */
const releaseMarker = (dir: string) => {
  try {
    return JSON.parse(readFileSync(join(dir, '.aico-release.json'), 'utf8')) as {
      sha: string
      built: string[]
    }
  } catch {
    return null
  }
}

/** Build output is never tracked: the donor's files the export does not have, hard-linked in. */
const HOST_LOCAL = new Set(['node_modules', '.next', '.venv', '__pycache__', '.dev-tools'])
function linkMissing(from: string, to: string) {
  mkdirSync(to, { recursive: true })
  for (const entry of readdirSync(from, { withFileTypes: true })) {
    if (HOST_LOCAL.has(entry.name)) continue
    const source = join(from, entry.name)
    const target = join(to, entry.name)
    if (entry.isDirectory()) linkMissing(source, target)
    else if (!existsSync(target)) {
      if (entry.isSymbolicLink()) symlinkSync(readlinkSync(source), target)
      else linkSync(source, target)
    }
  }
}

/**
 * Take a package's build from the newest earlier release that has it, when no source it is built from
 * changed between that release's commit and this one. The release stays one commit's exact content.
 */
function carryBuild(
  root: string,
  dir: string,
  sha: string,
  pkg: string,
  completion: Completion,
  deps: DeployDeps,
): boolean {
  const sources = [...completion.cfg.rootSources, ...cone(completion.workspace, pkg)]
  for (const name of releases(deps)) {
    if (name === sha || !releaseMarker(join(deps.releasesDir, name))?.built.includes(pkg)) continue
    const diff = deps.run('git', ['-C', root, 'diff', '--name-only', name, sha])
    if (diff.code !== 0 || touches(diff.out.split('\n').filter(Boolean), sources)) continue
    linkMissing(join(deps.releasesDir, name, 'packages', pkg), join(dir, 'packages', pkg))
    deps.out(`[deploy] ${pkg}: build carried over from release ${name.slice(0, 10)} (unchanged)`)
    return true
  }
  return false
}

/**
 * Export the commit, install, and build the packages the units need; an existing release is reused.
 * With a `completion`, every package a peer runs that was not rebuilt here is carried over from an
 * earlier release (or built when none matches), so each accepted release stands alone on a peer.
 */
export function prepareRelease(
  root: string,
  sha: string,
  builds: string[],
  deps: DeployDeps,
  completion?: Completion,
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
  const build = (pkg: string) => {
    const manifest = JSON.parse(readFileSafe(join(dir, 'packages', pkg, 'package.json')) ?? '{}')
    if (manifest.scripts?.build) {
      if (pkg === 'web-frontend') seedNextCache(dir, deps)
      step(`building ${pkg}`, 'npm', ['run', 'build', '-w', `packages/${pkg}`], dir)
    }
  }
  const done = (pkg: string) => {
    state.built.push(pkg)
    writeFileSync(marker, `${JSON.stringify(state)}\n`)
  }
  for (const pkg of builds) {
    if (state.built.includes(pkg)) continue
    build(pkg)
    done(pkg)
  }
  for (const pkg of completion?.packages ?? []) {
    if (state.built.includes(pkg)) continue
    if (!carryBuild(root, dir, sha, pkg, completion as Completion, deps)) build(pkg)
    done(pkg)
  }
  return dir
}

/** Tether's API version in a release's packages/tether/src/config.ts, or null when unreadable. */
export const configApiVersion = (configSource: string): number | null => {
  const match = /export const API_VERSION = (\d+)/.exec(configSource)
  return match ? Number(match[1]) : null
}

/** The instance a Tether unit serves (`tether@default.service`), or null for any other unit. */
const tetherInstance = (unit: string) =>
  /^tether@([A-Za-z0-9_-]+)\.service$/.exec(unit)?.[1] ?? null

/**
 * The running Tether daemon reports an older API than the release being deployed (`tether --json
 * version`, the daemon's /v1/version). An unreachable daemon is not "behind": it restarts anyway
 * when its code changed, and a deploy does not start what is stopped.
 */
function daemonBehind(deps: DeployDeps, unit: string, configSource: string): boolean {
  const instance = tetherInstance(unit)
  const wanted = configApiVersion(configSource)
  if (!instance || wanted === null) return false
  const answer = deps.run('tether', ['--instance', instance, '--json', 'version'], {
    env: deps.env,
  })
  if (answer.code !== 0) return false
  try {
    const running = (JSON.parse(answer.out) as { apiVersion?: unknown }).apiVersion
    return typeof running === 'number' && running < wanted
  } catch {
    return false
  }
}

const manualReason = (changed: boolean, behind: boolean) =>
  [
    changed && 'its sources changed since the release it runs',
    behind && 'the running daemon speaks an older API than this release',
  ]
    .filter(Boolean)
    .join('; ')

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
  /** CLI bundle used by the previous units; undefined means this swap did not change it. */
  previousOps?: string | null
  /** Each frontend `current` link's target before the swap (null: there was none). */
  previousFrontends?: Record<string, string | null>
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
  restoreOps(journal.previousOps, deps)
  restoreFrontends(journal.previousFrontends)
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
  installOps: boolean,
  cfg: DeployConfig = ops.deploy,
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
  let previousOps: string | null | undefined
  if (installOps) {
    try {
      previousOps = realpathSync(deps.opsLink)
    } catch {
      previousOps = null
    }
  }
  // A restarted server serves the release's own build from its link, the one before it kept earlier.
  const frontends = units
    .map((unit) => [unit, frontendSpec(cfg, unit)] as const)
    .filter(
      (pair): pair is readonly [string, FrontendSpec] =>
        !!pair[1] &&
        existsSync(join(release, 'packages', pair[1].package, pair[1].out, 'index.html')),
    )
  const previousFrontends: Record<string, string | null> = {}
  for (const [, spec] of frontends) {
    try {
      previousFrontends[currentLink(spec)] = readlinkSync(currentLink(spec))
    } catch {
      previousFrontends[currentLink(spec)] = null
    }
  }
  const journal: SwapJournal = {
    sha,
    started_at: new Date().toISOString(),
    previous,
    previousOps,
    previousFrontends,
  }
  writeFileSync(`${journalPath(deps)}.tmp`, JSON.stringify(journal))
  renameSync(`${journalPath(deps)}.tmp`, journalPath(deps))
  const fail = (failure: string) => {
    restoreOps(previousOps, deps)
    restoreFrontends(previousFrontends)
    const problem = restoreUnits(previous, deps)
    if (!problem) rmSync(journalPath(deps), { force: true })
    return {
      failure,
      outcome: problem
        ? `putting the previous units back failed too (${problem})`
        : 'the previous unit files were restored and restarted',
    }
  }
  if (installOps) installOpsBundle(deps, release)
  for (const [unit, spec] of frontends)
    pointFrontend(spec, release, deps, runningSha(previous[unit] ?? null, deps.releasesDir))
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

// ---- the served frontend -------------------------------------------------------------------

/**
 * A unit that serves a frontend build from a link (data/ops.json deploy.frontends): `<link>/current`
 * names the build it serves and `<link>/earlier-<sha>` the `keep` builds before it, whose hashed
 * assets tabs opened earlier still load. A deploy that changes only that build moves the link and
 * leaves the unit running.
 */
export interface FrontendSpec {
  package: string
  out: string
  link: string
  keep: number
}

export function frontendSpec(cfg: DeployConfig, unit: string): FrontendSpec | null {
  const spec = (cfg as { frontends?: Record<string, Partial<FrontendSpec>> }).frontends?.[unit]
  if (!spec?.package || !spec.link) return null
  return { package: spec.package, out: spec.out || 'out', link: spec.link, keep: spec.keep ?? 2 }
}

const currentLink = (spec: FrontendSpec) => join(expandHome(spec.link), 'current')

/** The unit text serves from the link (as written in the template: `~` is systemd's `%h`). */
export const servesLink = (unitText: string | null, spec: FrontendSpec) =>
  !!unitText?.includes(`${spec.link.replace(/^~(?=\/)/, '%h')}/current`)

const releaseOf = (path: string, deps: DeployDeps) => {
  try {
    return runningSha(`WorkingDirectory=${path}\n`, realpathSync(deps.releasesDir))
  } catch {
    return null
  }
}

/** The release commit whose build the link serves, or null when it names none. */
export function servedFrontendSha(spec: FrontendSpec, deps: DeployDeps): string | null {
  try {
    return releaseOf(realpathSync(currentLink(spec)), deps)
  } catch {
    return null
  }
}

/** Replace a link atomically (a new link renamed over the old). */
function relink(link: string, target: string) {
  const temporary = `${link}.${process.pid}.tmp`
  rmSync(temporary, { force: true })
  symlinkSync(target, temporary)
  renameSync(temporary, link)
}

/**
 * Point `current` at the release's build; the build it served becomes `earlier-<sha>`, and only the
 * newest `keep` earlier builds stay linked. `answering` is the release the server ran from when the
 * link named nothing (it served its own build then). Returns the previous target (null: none).
 */
export function pointFrontend(
  spec: FrontendSpec,
  release: string,
  deps: DeployDeps,
  answering: string | null = null,
): string | null {
  const build = join(release, 'packages', spec.package, spec.out)
  if (!existsSync(join(build, 'index.html')))
    throw new Refusal(`The release has no ${spec.package} build at ${build}`)
  const dir = expandHome(spec.link)
  mkdirSync(dir, { recursive: true })
  let previous: string | null = null
  try {
    previous = readlinkSync(currentLink(spec))
  } catch {}
  if (previous === build) return previous
  relink(currentLink(spec), build)
  const before =
    previous ??
    (answering ? join(deps.releasesDir, answering, 'packages', spec.package, spec.out) : null)
  if (before && before !== build && existsSync(before))
    relink(join(dir, `earlier-${releaseOf(realpathSync(before), deps) ?? Date.now()}`), before)
  const earlier = readdirSync(dir)
    .filter((name) => /^earlier-[^.]+$/.test(name))
    .map((name) => join(dir, name))
    .sort((a, b) => lstatSync(b).mtimeMs - lstatSync(a).mtimeMs)
  for (const [index, link] of earlier.entries())
    if (index >= spec.keep || !existsSync(link) || readlinkSync(link) === build)
      rmSync(link, { force: true })
  deps.out(`[deploy] the page is now served from ${release.split('/').at(-1)?.slice(0, 12)}`)
  return previous
}

/** Put `current` links back as they were (null: remove it, so the server answers with its own build). */
function restoreFrontends(previous: Record<string, string | null> | undefined) {
  for (const [link, target] of Object.entries(previous ?? {}))
    if (target === null) rmSync(link, { force: true })
    else relink(link, target)
}

/** The builds the frontend links (current and earlier) serve, as real paths. */
function frontendBuilds(cfg: DeployConfig): string[] {
  const found: string[] = []
  for (const unit of Object.keys((cfg as { frontends?: object }).frontends ?? {})) {
    const spec = frontendSpec(cfg, unit)
    if (!spec) continue
    const dir = expandHome(spec.link)
    let names: string[] = []
    try {
      names = readdirSync(dir)
    } catch {}
    for (const name of names)
      try {
        found.push(realpathSync(join(dir, name)))
      } catch {}
  }
  return found
}

/**
 * Serve the release's build from each unit's link without restarting it, then check the page still
 * answers; on failure the previous builds are linked back.
 */
async function swapFrontends(
  project: Project,
  units: string[],
  release: string,
  cfg: DeployConfig,
  deps: DeployDeps,
): Promise<{ failure: string; outcome: string } | null> {
  const previous: Record<string, string | null> = {}
  try {
    for (const unit of units) {
      const spec = frontendSpec(cfg, unit) as FrontendSpec
      const own = runningSha(readFileSafe(join(deps.systemdDir, unit)), deps.releasesDir)
      previous[currentLink(spec)] = pointFrontend(spec, release, deps, own)
    }
  } catch (error) {
    restoreFrontends(previous)
    return { failure: (error as Error).message, outcome: 'the previous page was linked back' }
  }
  if (units.includes(project.backend) && project.port) {
    let status = 0
    for (let i = 0; i < ops.deploy.healthAttempts && !(status >= 200 && status < 400); i++) {
      if (i) await deps.sleep(1_000)
      status = await deps.probe(`http://127.0.0.1:${project.port}/`)
    }
    deps.out(`[deploy] ${project.backend} /: ${status || 'no answer'}`)
    if (!(status >= 200 && status < 400)) {
      restoreFrontends(previous)
      return {
        failure: `${project.backend} / answered ${status || 'nothing'}`,
        outcome: 'the previous page was linked back',
      }
    }
  }
  return null
}

// ---- the root install (host-steward) ---------------------------------------------------------

/**
 * Keep the newest releases, every one a unit file still runs, every one whose frontend build a link
 * serves (current or kept earlier) and every one a live process runs from (a job started before a
 * deploy keeps reading its release's data files); the rest are rebuildable.
 */
export function pruneReleases(deps: DeployDeps, current: string, cfg: DeployConfig = ops.deploy) {
  const units = existsSync(deps.systemdDir)
    ? readdirSync(deps.systemdDir)
        .map((name) => readFileSafe(join(deps.systemdDir, name)) ?? '')
        .join('\n')
    : ''
  const live = deps.processPaths().join('\n')
  const served = frontendBuilds(cfg)
  let realReleases = deps.releasesDir
  try {
    realReleases = realpathSync(deps.releasesDir)
  } catch {}
  for (const [index, name] of releases(deps).entries()) {
    const path = join(deps.releasesDir, name)
    if (
      index < ops.deploy.keepReleases ||
      path === current ||
      units.includes(`${path}/`) ||
      live.includes(path) ||
      served.some((build) => build.startsWith(`${join(realReleases, name)}/`)) ||
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
      const answer = deps.run('systemctl', ['--user', 'is-active', `aico-deploy-${id}.service`], {
        env: userBusEnv(deps.env),
      })
      const unit = answer.out.trim()
      if (
        ['inactive', 'failed', 'unknown'].includes(unit) &&
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
