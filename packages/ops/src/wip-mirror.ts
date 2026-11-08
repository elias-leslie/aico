// `aico wip`: a copy of the active repos, uncommitted work included, on the other full Aico machines.
// It turns itself on when the fleet has another full-role machine on other hardware and is off and
// quiet otherwise. One job per full machine runs `aico wip run`; each repo has one bare mirror per
// receiver, under refs/aico/wip/<this machine>/{heads,stash}/<branch>. Nothing here touches a user's
// index, HEAD, stash or working tree, and nothing goes to GitHub or any other remote: the only
// destination is a peer reached over the fleet link (`tether fleet exec`), never an ssh alias.
// Limits and exclusions are data/wip-mirror.json; the interval is the job in packages/jobs.

import { createHash } from 'node:crypto'
import {
  copyFileSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { requestExec, runExec } from '@aico/fleet/exec'
import { fullPeers } from '@aico/fleet/peers'
import { readSettings } from '@aico/fleet/settings'
import { readPins } from '@aico/fleet/trust'
import { deleteStatusRow, machineId, outboxDir, postOrKeep, type StatusRow } from '@aico/status'
import wipConfig from '../data/wip-mirror.json' with { type: 'json' }
import { Refusal } from './deploy'
import { expandHome, type Runner, type RunResult, run as shell, tail } from './sh'

export type WipConfig = typeof wipConfig

const MB = 1024
const bootIdPath = '/proc/sys/kernel/random/boot_id'
const PROJECT = /^[a-z0-9][a-z0-9_-]{0,99}$/
const sq = (value: string) => `'${value.replaceAll("'", `'\\''`)}'`
const mb = (kib: number) =>
  kib >= 1024 * 1024 ? `${(kib / 1024 / 1024).toFixed(1)} GB` : `${Math.round(kib / 1024)} MB`

/** A full peer, as the mirror uses it. */
export interface Peer {
  name: string
  /** Runs a shell script in the peer's home as its Aico user. */
  exec(script: string): Promise<{ code: number; out: string }>
  /** The git address of a path below the peer's home, and the environment git needs to reach it. */
  remote(rel: string): { url: string; env: NodeJS.ProcessEnv }
}

export interface WipProject {
  id: string
  root: string
  name?: string
}

export interface WipDeps {
  cfg: WipConfig
  git: Runner
  machine: string
  /** The full peers on other hardware; `off` is the plain reason there are none. */
  peers(): Promise<{ peers: Peer[]; off: string | null }>
  projects(): WipProject[]
  /** Only these projects (the run after a commit); the rest of the state is left alone. */
  only?: string[]
  localBootId(): string | null
  state: string
  now(): Date
  /** Where a project's standby checkout goes on a peer (default: the same path as here). */
  standbyRoot?(root: string): string
}

export interface Problem {
  /** The Status row's suffix: a project id, or `peer-NAME`. */
  key: string
  what: string
  project?: string
  state: 'warn' | 'failed'
  reason: string
}

export interface WipReport {
  /** Why nothing was copied because nothing should be, else null. */
  off: string | null
  mirrored: string[]
  unchanged: number
  problems: Problem[]
  /** The Status row keys that now stand, for the caller to clear the others. */
  rows: string[]
  /** Repos outside the pinned list with no commits or uncommitted work in the active window. */
  idle: number
}

interface RepoState {
  /** Fingerprint last pushed, per peer. */
  pushed: Record<string, string>
  problem?: Problem
  /** The branch and heads each peer's standby checkout was last brought to. */
  standby?: Record<string, string>
  standbyProblem?: Problem
}
interface WipState {
  repos: Record<string, RepoState>
  /** Status row ids posted by the last run. */
  rows: string[]
}

function readState(path: string): WipState {
  try {
    const value = JSON.parse(readFileSync(path, 'utf8')) as Partial<WipState>
    return { repos: value.repos ?? {}, rows: value.rows ?? [] }
  } catch {
    return { repos: {}, rows: [] }
  }
}
function writeState(path: string, state: WipState): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
  writeFileSync(`${path}.tmp`, JSON.stringify(state), { mode: 0o600 })
  renameSync(`${path}.tmp`, path)
}

const quietEnv = (extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv => ({
  ...process.env,
  GIT_OPTIONAL_LOCKS: '0',
  GIT_TERMINAL_PROMPT: '0',
  ...extra,
})

function skipReason(cfg: WipConfig, project: WipProject): string | null {
  const segments = project.root.split('/')
  const hit = cfg.skipPaths.find(
    (rule) => project.id === rule.segment || segments.includes(rule.segment),
  )
  return hit ? hit.reason : null
}

/** What changed in the working tree, as a fingerprint of paths with their size and mtime. */
function dirtyState(
  git: Runner,
  root: string,
): { fingerprint: string; paths: number; kib: number } | { error: string } {
  const status = git(
    'git',
    ['-C', root, 'status', '--porcelain=v1', '-z', '--untracked-files=all'],
    {
      env: quietEnv(),
    },
  )
  if (status.code) return { error: `git status failed: ${tail(status, 3)}` }
  const records = status.out.split('\0')
  const hash = createHash('sha1')
  let paths = 0
  let bytes = 0
  for (let i = 0; i < records.length; i++) {
    const record = records[i] as string
    if (!record) continue
    const path = record.slice(3)
    if (record[0] === 'R' || record[0] === 'C') i++
    paths++
    try {
      const stat = lstatSync(join(root, path))
      bytes += stat.isFile() ? stat.size : 0
      hash.update(`${record.slice(0, 2)} ${path} ${stat.size} ${stat.mtimeMs}\n`)
    } catch {
      hash.update(`${record.slice(0, 2)} ${path} gone\n`)
    }
  }
  return { fingerprint: hash.digest('hex'), paths, kib: Math.ceil(bytes / 1024) }
}

/**
 * The working tree as a commit on top of HEAD, built in a throwaway index (a copy of the real one,
 * so unchanged files are not read again). The real index, HEAD, refs and files are not touched;
 * the only effect on the repo is new objects. Null when the tree equals HEAD's.
 */
function wipCommit(
  git: Runner,
  root: string,
  head: string | null,
  label: string,
  cfg: WipConfig,
): { sha: string } | { error: string } | null {
  const dir = mkdtempSync(join(tmpdir(), 'aico-wip-'))
  try {
    const real = git(
      'git',
      ['-C', root, 'rev-parse', '--path-format=absolute', '--git-path', 'index'],
      {
        env: quietEnv(),
      },
    )
    const index = join(dir, 'index')
    const env = quietEnv({
      GIT_INDEX_FILE: index,
      GIT_AUTHOR_NAME: 'Aico WIP',
      GIT_AUTHOR_EMAIL: 'wip@aico.invalid',
      GIT_COMMITTER_NAME: 'Aico WIP',
      GIT_COMMITTER_EMAIL: 'wip@aico.invalid',
    })
    let seeded = false
    if (!real.code) {
      try {
        copyFileSync(real.out.trim(), index)
        seeded = true
      } catch {}
    }
    if (!seeded && head) {
      const read = git('git', ['-C', root, 'read-tree', head], { env })
      if (read.code) return { error: `git read-tree failed: ${tail(read, 3)}` }
    }
    const add = git(
      'git',
      [
        '-C',
        root,
        'add',
        '-A',
        '--',
        '.',
        ...cfg.excludeFiles.map((name) => `:(exclude,glob)**/${name}`),
      ],
      { env },
    )
    if (add.code) return { error: `could not read the working tree: ${tail(add, 3)}` }
    const tree = git('git', ['-C', root, 'write-tree'], { env })
    if (tree.code) return { error: `git write-tree failed: ${tail(tree, 3)}` }
    const treeId = tree.out.trim()
    if (head) {
      const same = git('git', ['-C', root, 'rev-parse', `${head}^{tree}`], { env: quietEnv() })
      if (!same.code && same.out.trim() === treeId) return null
    }
    const made = git(
      'git',
      ['-C', root, 'commit-tree', treeId, ...(head ? ['-p', head] : []), '-m', label],
      { env },
    )
    return made.code
      ? { error: `git commit-tree failed: ${tail(made, 3)}` }
      : { sha: made.out.trim() }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

interface Disk {
  freeKiB: number
  usedKiB: number
  have: Set<string>
}

async function look(peer: Peer, cfg: WipConfig, machine: string): Promise<Disk | string> {
  const dir = sq(cfg.mirrorDir)
  const answer = await peer.exec(
    `mkdir -p ${dir}/${sq(machine)} && df -Pk ${dir} | tail -n 1 && du -sk ${dir} && ls -1 ${dir}/${sq(machine)}`,
  )
  if (answer.code)
    return `${peer.name} did not answer (${answer.out.trim().split('\n').at(-1) || `exit ${answer.code}`})`
  const [df, du, ...names] = answer.out.trim().split('\n')
  const free = Number(df?.trim().split(/\s+/)[3])
  const used = Number(du?.split(/\s+/)[0])
  if (!Number.isFinite(free) || !Number.isFinite(used))
    return `${peer.name} gave a disk reading Aico cannot read`
  return { freeKiB: free, usedKiB: used, have: new Set(names.map((n) => n.replace(/\.git$/, ''))) }
}

function failureOf(result: RunResult, what: string): string {
  return `${what}: ${tail(result, 2).replace(/\s+/g, ' ')}`
}

/** One run over every project. Pure of Status and of the process: the caller prints and posts. */
export async function mirror(deps: WipDeps): Promise<WipReport> {
  const { cfg, git, machine } = deps
  const found = await deps.peers()
  if (found.off)
    return {
      off: found.off,
      mirrored: [],
      unchanged: 0,
      problems: [],
      rows: readState(deps.state).rows,
      idle: 0,
    }
  const state = readState(deps.state)
  const report: WipReport = {
    off: null,
    mirrored: [],
    unchanged: 0,
    problems: [],
    rows: [],
    idle: 0,
  }
  const disks = new Map<string, Disk>()
  const targets: Peer[] = []
  for (const peer of found.peers) {
    const disk = await look(peer, cfg, machine)
    if (typeof disk === 'string')
      report.problems.push({
        key: `peer-${peer.name}`,
        what: `Repo copy to ${peer.name}`,
        state: 'failed',
        reason: disk,
      })
    else {
      disks.set(peer.name, disk)
      targets.push(peer)
    }
  }
  const projects = deps.projects()
  for (const project of projects) {
    if (deps.only && !deps.only.includes(project.id)) continue
    const problems: string[] = []
    let failed = false
    const note = (state: 'warn' | 'failed', reason: string) => {
      problems.push(reason)
      failed ||= state === 'failed'
    }
    if (skipReason(cfg, project)) continue
    if (!PROJECT.test(project.id)) {
      report.problems.push({
        key: 'bad-id',
        what: 'Repo copy',
        state: 'warn',
        reason: `${project.id}: not a usable project name`,
      })
      continue
    }
    const inside = git('git', ['-C', project.root, 'rev-parse', '--git-dir'], { env: quietEnv() })
    if (inside.code) continue
    const dirty = dirtyState(git, project.root)
    if ('error' in dirty) {
      report.problems.push({
        key: project.id,
        what: `Repo copy: ${project.id}`,
        project: project.id,
        state: 'failed',
        reason: `${project.id}: ${dirty.error}`,
      })
      continue
    }
    if (!cfg.pinned.includes(project.id) && !dirty.paths) {
      const last = git(
        'git',
        [
          '-C',
          project.root,
          'for-each-ref',
          '--sort=-committerdate',
          '--count=1',
          '--format=%(committerdate:unix)',
          'refs/heads',
        ],
        { env: quietEnv() },
      )
      const newest = Number(last.out.trim())
      if (!newest || deps.now().getTime() / 1000 - newest > cfg.activeDays * 86400) {
        report.idle++
        continue
      }
    }
    const sizes = git('git', ['-C', project.root, 'count-objects', '-v'], { env: quietEnv() })
    const kib = Object.fromEntries(
      sizes.out.split('\n').map((line) => line.split(': ') as [string, string]),
    ) as Record<string, string>
    const repoKiB =
      Number(kib.size ?? 0) + Number(kib['size-pack'] ?? 0) + Number(kib['size-garbage'] ?? 0)
    if (repoKiB > cfg.maxRepoMb * MB) {
      report.problems.push({
        key: project.id,
        what: `Repo copy: ${project.id}`,
        project: project.id,
        state: 'warn',
        reason: `${project.id}: not copied, git data is ${mb(repoKiB)} (limit ${cfg.maxRepoMb} MB)`,
      })
      continue
    }
    const entry = state.repos[project.id] ?? { pushed: {} }
    state.repos[project.id] = entry
    const headRead = git('git', ['-C', project.root, 'rev-parse', '-q', '--verify', 'HEAD'], {
      env: quietEnv(),
    })
    const head = headRead.code ? null : headRead.out.trim()
    const heads = git(
      'git',
      ['-C', project.root, 'for-each-ref', '--format=%(objectname) %(refname)', 'refs/heads'],
      { env: quietEnv() },
    )
    const fingerprint = createHash('sha1')
      .update(`${head}\n${heads.out}\n${dirty.fingerprint}`)
      .digest('hex')
    const todo = targets.filter((peer) => entry.pushed[peer.name] !== fingerprint)
    if (!todo.length) {
      if (entry.problem) report.problems.push(entry.problem)
      if (found.peers.length === targets.length) report.unchanged++
      await keepStandby(deps, project, entry, fingerprint, heads.out, targets, report)
      continue
    }
    const branchRead = git('git', ['-C', project.root, 'symbolic-ref', '-q', '--short', 'HEAD'], {
      env: quietEnv(),
    })
    const branch = branchRead.code ? 'detached' : branchRead.out.trim()
    let wip: { sha: string } | null = null
    let skippedWip: string | null = null
    if (dirty.paths) {
      if (dirty.kib > cfg.maxDirtyMb * MB)
        skippedWip = `uncommitted work is ${mb(dirty.kib)} (limit ${cfg.maxDirtyMb} MB), only branches copied`
      else {
        const made = wipCommit(
          git,
          project.root,
          head,
          `aico wip ${machine} ${branch} ${deps.now().toISOString()}`,
          cfg,
        )
        if (made && 'error' in made) note('failed', made.error)
        else wip = made
      }
    }
    if (skippedWip) note('warn', skippedWip)
    const prefix = `refs/aico/wip/${machine}`
    const wanted = new Map<string, string>()
    for (const line of heads.out.trim().split('\n').filter(Boolean)) {
      const [sha, ref] = line.split(' ') as [string, string]
      wanted.set(`${prefix}/heads/${ref.slice('refs/heads/'.length)}`, sha)
    }
    if (wip) wanted.set(`${prefix}/stash/${branch}`, wip.sha)
    if (!failed) {
      for (const peer of todo) {
        const disk = disks.get(peer.name) as Disk
        const rel = `${cfg.mirrorDir}/${machine}/${project.id}.git`
        const fresh = !disk.have.has(project.id)
        if (disk.freeKiB - repoKiB < cfg.minFreeMb * MB) {
          note(
            'warn',
            `not copied to ${peer.name}, it has ${mb(disk.freeKiB)} free (keeps ${cfg.minFreeMb} MB)`,
          )
          continue
        }
        if (fresh && disk.usedKiB + repoKiB > cfg.maxMirrorMb * MB) {
          note('warn', `not copied to ${peer.name}, copies there would pass ${cfg.maxMirrorMb} MB`)
          continue
        }
        const init = await peer.exec(
          `git init --bare -q ${sq(rel)} && git -C ${sq(rel)} config gc.pruneExpire 1.day.ago`,
        )
        if (init.code) {
          note(
            'failed',
            `${peer.name}: could not prepare the mirror (${init.out.trim().split('\n').at(-1)})`,
          )
          continue
        }
        const { url, env } = peer.remote(rel)
        const gitEnv = quietEnv(env)
        const listed = git('git', ['-C', project.root, 'ls-remote', url, `${prefix}/*`], {
          env: gitEnv,
        })
        if (listed.code) {
          note('failed', failureOf(listed, `${peer.name}: could not read the mirror`))
          continue
        }
        const there = listed.out
          .trim()
          .split('\n')
          .filter(Boolean)
          .map((line) => line.split('\t')[1] as string)
        const specs = [
          ...[...wanted].map(([ref, sha]) => `+${sha}:${ref}`),
          ...there.filter((ref) => !wanted.has(ref)).map((ref) => `:${ref}`),
        ]
        const pushed = git(
          'git',
          ['-C', project.root, 'push', '--no-verify', '-q', url, ...specs],
          { env: gitEnv },
        )
        if (pushed.code) {
          note('failed', failureOf(pushed, `${peer.name}: push failed`))
          continue
        }
        entry.pushed[peer.name] = fingerprint
        if (fresh) {
          disk.usedKiB += repoKiB
          disk.have.add(project.id)
        }
      }
      if (todo.some((peer) => entry.pushed[peer.name] === fingerprint))
        report.mirrored.push(project.id)
    }
    if (problems.length) {
      const worst: Problem = {
        key: project.id,
        what: `Repo copy: ${project.id}`,
        project: project.id,
        state: failed ? 'failed' : 'warn',
        reason: `${project.id}: ${problems.join('; ')}`,
      }
      report.problems.push(worst)
      // A skip that retrying cannot fix is carried until the repo changes again.
      if (!failed) entry.problem = worst
      else delete entry.problem
    } else delete entry.problem
    await keepStandby(deps, project, entry, fingerprint, heads.out, targets, report)
  }
  if (!deps.only) {
    const kept = new Set(projects.map((p) => p.id))
    for (const id of Object.keys(state.repos)) if (!kept.has(id)) delete state.repos[id]
    state.rows = report.problems.map((p) => p.key)
  } else
    state.rows = [
      ...state.rows.filter(
        (key) =>
          !deps.only?.some((id) => key === id || key === `${id}-standby`) &&
          !key.startsWith('peer-'),
      ),
      ...report.problems.map((p) => p.key),
    ]
  report.rows = state.rows
  writeState(deps.state, state)
  return report
}

export function summary(report: WipReport, machine: string, peers: number): string {
  if (report.off) return report.off
  const failed = report.problems.filter((p) => p.state === 'failed')
  const warned = report.problems.filter((p) => p.state === 'warn')
  const parts = [
    `${report.mirrored.length} ${report.mirrored.length === 1 ? 'repo' : 'repos'} copied to ${peers} ${peers === 1 ? 'machine' : 'machines'}, ${report.unchanged} unchanged${report.idle ? `, ${report.idle} not active` : ''}`,
  ]
  if (failed.length) parts.push(`Failed: ${failed.map((p) => p.reason).join('; ')}`)
  if (warned.length) parts.push(`Skipped: ${warned.map((p) => p.reason).join('; ')}`)
  return `${machine}: ${parts.join('. ')}.`
}

function problemRow(problem: Problem, machine: string, at: Date): StatusRow {
  return {
    id: `${machine}/wip-mirror/${problem.key}`,
    what: problem.what,
    kind: 'repo',
    machine,
    ...(problem.project ? { project: problem.project } : {}),
    state: problem.state,
    meaning: problem.reason.length > 700 ? `${problem.reason.slice(0, 699)}…` : problem.reason,
    last_run: at.toISOString(),
    actions: [{ kind: 'run', ref: `aico jobs run wip-mirror-${machine}` }],
  }
}

// ---- the real fleet-backed peers ------------------------------------------------------------

/** `GIT_SSH_COMMAND` for git over the fleet link: git runs it as `<this> HOST 'git-receive-pack PATH'`. */
/**
 * A working checkout on each peer, for a session there to start in while this machine is down:
 * only from the machines in `standby.from`, only once the peer's mirror has this repo's heads.
 */
async function keepStandby(
  deps: WipDeps,
  project: WipProject,
  entry: RepoState,
  fingerprint: string,
  heads: string,
  peers: Peer[],
  report: WipReport,
): Promise<void> {
  const { cfg, git, machine } = deps
  if (!cfg.standby.from.includes(machine)) return
  const branchRead = git('git', ['-C', project.root, 'symbolic-ref', '-q', '--short', 'HEAD'], {
    env: quietEnv(),
  })
  if (branchRead.code) return
  const branch = branchRead.out.trim()
  const print = createHash('sha1').update(`${branch}\n${heads}`).digest('hex')
  const root = deps.standbyRoot ? deps.standbyRoot(project.root) : project.root
  const rel = `${cfg.mirrorDir}/${machine}/${project.id}.git`
  const problems: string[] = []
  let failed = false
  let ran = false
  for (const peer of peers) {
    if (entry.pushed[peer.name] !== fingerprint || entry.standby?.[peer.name] === print) continue
    ran = true
    const done = await peer.exec(standbyScript(cfg, project, root, rel, machine, branch))
    const last = done.out.trim().split('\n').at(-1) ?? ''
    if (done.code || !last.startsWith('standby: ')) {
      failed = true
      problems.push(`${peer.name}: could not update the checkout (${last || 'no answer'})`)
      continue
    }
    const said = last.slice('standby: '.length)
    if (said.startsWith('left ')) problems.push(`${peer.name}: ${root} ${said}`)
    entry.standby = { ...entry.standby, [peer.name]: print }
  }
  if (ran) {
    if (problems.length)
      entry.standbyProblem = {
        key: `${project.id}-standby`,
        what: `Standby checkout: ${project.id}`,
        project: project.id,
        state: failed ? 'failed' : 'warn',
        reason: `${project.id}: ${problems.join('; ')}`,
      }
    else delete entry.standbyProblem
  }
  if (entry.standbyProblem) report.problems.push(entry.standbyProblem)
}

/**
 * The peer side of a standby checkout: BRANCH at ROOT, listed in the peer's projects. It only
 * moves forward to this machine's heads; a checkout with its own changes or commits, a remote of
 * the same name pointing elsewhere, or a folder that is not a Git checkout is left as it is.
 * The last line says what happened.
 */
function standbyScript(
  cfg: WipConfig,
  project: WipProject,
  root: string,
  rel: string,
  machine: string,
  branch: string,
): string {
  const remote = `wip-${machine}`
  const aico = `"$HOME"/${sq(cfg.standby.aico)}`
  const name = project.name ? ` --name ${sq(project.name)}` : ''
  return `mirror="$PWD"/${sq(rel)}; root=${sq(root)}; remote=${sq(remote)}; branch=${sq(branch)}
track="refs/remotes/$remote/$branch"; spec=${sq(`+refs/aico/wip/${machine}/heads/*:refs/remotes/${remote}/*`)}
say() { echo "standby: $*"; }
if [ ! -e "$root" ]; then
  git clone -q --no-checkout -o "$remote" "$mirror" "$root" 2>/dev/null || { say "could not create $root"; exit 1; }
  git -C "$root" config "remote.$remote.fetch" "$spec"
  git -C "$root" fetch -q "$remote" && git -C "$root" checkout -q -b "$branch" "$track" || { say "could not check out $branch"; exit 1; }
  state=created
elif ! git -C "$root" rev-parse --git-dir >/dev/null 2>&1; then
  say "left as it is: the folder is not a Git checkout"; exit 0
else
  url=$(git -C "$root" remote get-url "$remote" 2>/dev/null)
  if [ -z "$url" ]; then
    git -C "$root" remote add "$remote" "$mirror" && git -C "$root" config "remote.$remote.fetch" "$spec"
  elif [ "$url" != "$mirror" ]; then
    say "left as it is: its remote $remote points elsewhere"; exit 0
  fi
  git -C "$root" fetch -q "$remote" || { say "could not fetch"; exit 1; }
  if [ -n "$(git -C "$root" status --porcelain --untracked-files=no)" ]; then say "left as it is: it has its own changes"; exit 0; fi
  if git -C "$root" rev-parse -q --verify "refs/heads/$branch" >/dev/null && ! git -C "$root" merge-base --is-ancestor "refs/heads/$branch" "$track"; then
    say "left as it is: its $branch has commits that ${machine}'s does not"; exit 0
  fi
  now=$(git -C "$root" symbolic-ref -q --short HEAD)
  if [ "$now" != "$branch" ] && [ -z "$(git -C "$root" branch -r --contains HEAD --list "$remote/*")" ]; then
    say "left as it is: it is on \${now:-a detached HEAD} with commits of its own"; exit 0
  fi
  git -C "$root" checkout -q -B "$branch" "$track" 2>/dev/null || { say "left as it is: files there are in the way"; exit 0; }
  state=current
fi
${aico} projects show ${sq(project.id)} >/dev/null 2>&1 || ${aico} projects register ${sq(project.id)} --root "$root"${name} >/dev/null 2>&1 || { say "$state, but could not list it in projects"; exit 1; }
say "$state"`
}

function linkShellCommand(socket: string): string {
  return `${sq(process.execPath)} ${sq(process.argv[1] as string)} wip link-shell ${sq(socket)}`
}

export function fleetPeers(
  deps: Pick<WipDeps, 'localBootId'>,
  env = process.env,
): WipDeps['peers'] {
  return async () => {
    const settings = readSettings(env, '')
    if (!settings) return { peers: [], off: 'Off: this machine is not part of a fleet.' }
    const found = fullPeers(settings, readPins(settings.allowlist))
    if (found.role !== 'full')
      return {
        peers: [],
        off: 'Off: only a full Aico machine keeps repo copies; this one is a worker.',
      }
    const mine = deps.localBootId()
    const peers: Peer[] = []
    const together = [...found.sameComputer]
    for (const peer of found.peers) {
      const exec = async (script: string) => {
        const answer = await requestExec(
          peer.exec,
          ['sh', '-c', `cd "$HOME" && ${script}`],
          Buffer.alloc(0),
        )
        return { code: answer.code, out: `${answer.stdout}${answer.output}` }
      }
      const theirs = await exec(`cat ${bootIdPath}`)
      if (mine && theirs.code === 0 && theirs.out.trim() === mine) {
        together.push(peer.name)
        continue
      }
      peers.push({
        name: peer.name,
        exec,
        remote: (rel) => ({
          url: `${peer.name}:${rel}`,
          env: {
            GIT_SSH_COMMAND: linkShellCommand(peer.exec),
            GIT_CONFIG_COUNT: '1',
            GIT_CONFIG_KEY_0: 'ssh.variant',
            GIT_CONFIG_VALUE_0: 'simple',
          },
        }),
      })
    }
    if (!peers.length)
      return {
        peers,
        off: together.length
          ? `Off: the other full Aico (${together.join(', ')}) runs on this computer, so a copy here would not survive it failing.`
          : 'Off: no other full Aico in the fleet yet. Repo copies start by themselves once there is one on other hardware.',
      }
    return { peers, off: null }
  }
}

function registryProjects(cfg: WipConfig, git: Runner): () => WipProject[] {
  return () => {
    const [file, ...args] = cfg.projectsCommand
    const listed = git(file as string, args)
    if (listed.code) throw new Refusal(`could not list projects: ${tail(listed, 3)}`)
    return (JSON.parse(listed.out) as { id: string; name?: string; root_path: string }[]).map(
      (p) => ({ id: p.id, root: p.root_path, name: p.name }),
    )
  }
}

function realDeps(env = process.env): WipDeps {
  const cfg = wipConfig
  const localBootId = () => {
    try {
      return readFileSync(bootIdPath, 'utf8').trim()
    } catch {
      return null
    }
  }
  return {
    cfg,
    git: shell,
    machine: machineId(),
    peers: fleetPeers({ localBootId }, env),
    projects: registryProjects(cfg, shell),
    localBootId,
    state: expandHome(cfg.state),
    now: () => new Date(),
  }
}

async function postRows(rows: StatusRow[], gone: string[], env: NodeJS.ProcessEnv): Promise<void> {
  const base = env.AICO_WEB_URL || wipConfig.webUrl
  if (rows.length) {
    const waiting = await postOrKeep(base, rows, {
      dir: outboxDir(env.AICO_DATA_DIR || expandHome('~/.local/state/aico')),
      timeoutMs: 10_000,
    })
    if (waiting !== null) console.error(`Repo copy Status will go out later: ${waiting}`)
  }
  for (const id of gone) {
    await deleteStatusRow(base, id, { timeoutMs: 10_000 }).catch(() => {})
  }
}

const USAGE = `Usage:
  aico wip run [PROJECT...]         copy changed active repos (branches and uncommitted work) to the other full machines
  aico wip restore PROJECT [--of MACHINE] [--from MACHINE] --to DIR
      fetch a repo's latest copy into a new folder DIR; --of names the machine whose work it was
      (default this one; another machine's copy is read from this machine's own mirror), --from
      the machine to read it from
  runs by itself as the wip-mirror job; limits and exclusions are packages/ops/data/wip-mirror.json`

export async function wip(argv: string[], env = process.env): Promise<number> {
  const [verb, ...rest] = argv
  if (!verb || verb === '--help' || verb === '-h' || verb === 'help') {
    console.log(USAGE)
    return 0
  }
  if (verb === 'link-shell') return linkShell(rest)
  if (verb === 'restore') return restoreWip(rest, realDeps(env))
  if (verb !== 'run') throw new Refusal(`aico wip: unknown command ${verb}\n${USAGE}`, 2)
  const flag = rest.find((arg) => arg.startsWith('-'))
  if (flag) throw new Refusal(`aico wip run: unknown option ${flag}\n${USAGE}`, 2)
  const deps = realDeps(env)
  const only = rest
  if (only.length) deps.only = only
  const before = readState(deps.state).rows
  const report = await mirror(deps)
  const found = report.off ? null : await deps.peers()
  const rows = report.problems.map((p) => problemRow(p, deps.machine, deps.now()))
  await postRows(
    rows,
    before
      .filter((key) => !report.rows.includes(key))
      .map((key) => `${deps.machine}/wip-mirror/${key}`),
    env,
  )
  const line = summary(report, deps.machine, found?.peers.length ?? 0)
  console.log(line)
  return report.problems.some((p) => p.state === 'failed') ? 1 : 0
}

/** git's ssh stand-in: `link-shell SOCKET HOST COMMAND` runs COMMAND on the peer over the fleet link. */
async function linkShell(args: string[]): Promise<number> {
  const [socket, , command] = args
  if (!socket || !command) throw new Refusal('usage: aico wip link-shell SOCKET HOST COMMAND', 2)
  return runExec(socket, ['sh', '-c', `cd "$HOME" && ${command}`])
}

export async function restoreWip(args: string[], deps: WipDeps): Promise<number> {
  const flag = (name: string) => {
    const at = args.indexOf(name)
    return at >= 0 ? args[at + 1] : undefined
  }
  const project = args[0]
  const to = flag('--to')
  if (!project || project.startsWith('-') || !to) throw new Refusal(USAGE, 2)
  if (!PROJECT.test(project)) throw new Refusal(`${project} is not a project name`, 2)
  const of = flag('--of') ?? deps.machine
  const from = flag('--from')
  const dest = resolve(to)
  try {
    lstatSync(dest)
    throw new Refusal(`${dest} already exists; choose a new folder so nothing is overwritten`, 2)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
  const rel = `${deps.cfg.mirrorDir}/${of}/${project}.git`
  // Where the copies are: this machine's own mirror holds other machines' work; for its own work, the peers do.
  const sources: { name: string; url: string; env: NodeJS.ProcessEnv }[] =
    of !== deps.machine && !from
      ? [{ name: deps.machine, url: join(expandHome('~'), rel), env: {} }]
      : (await deps.peers()).peers
          .filter((peer) => !from || peer.name === from)
          .map((peer) => ({ name: peer.name, ...peer.remote(rel) }))
  if (!sources.length) throw new Refusal('no machine to read the copy from (see --from)', 1)
  mkdirSync(dest, { recursive: true })
  deps.git('git', ['-C', dest, 'init', '-q'])
  for (const source of sources) {
    const fetched = deps.git(
      'git',
      ['-C', dest, 'fetch', '-q', source.url, `+refs/aico/wip/${of}/*:refs/wip/${source.name}/*`],
      { env: quietEnv(source.env) },
    )
    if (fetched.code) console.error(`${source.name}: ${tail(fetched, 2)}`)
  }
  const refs = deps.git('git', [
    '-C',
    dest,
    'for-each-ref',
    '--sort=-committerdate',
    '--format=%(refname) %(committerdate:unix) %(committerdate:iso8601)',
    'refs/wip/',
  ])
  const lines = refs.out.trim().split('\n').filter(Boolean)
  if (!lines.length) {
    rmSync(dest, { recursive: true, force: true })
    throw new Refusal(
      `no copy of ${project} by ${of} found on ${sources.map((s) => s.name).join(', ')}`,
      1,
    )
  }
  const best = lines
    .map((line) => line.split(' ')[0] as string)
    .find((ref) => ref.includes('/stash/'))
  console.log(`Copies of ${project} by ${of}, newest first (refs in ${dest}):`)
  for (const line of lines)
    console.log(`  ${line.split(' ')[0]}  ${line.split(' ').slice(2).join(' ')}`)
  if (best) {
    deps.git('git', ['-C', dest, 'checkout', '-q', '-b', 'wip-restored', best])
    console.log(
      `\nChecked out the newest uncommitted-work copy as branch wip-restored in ${dest}: the files as they were, committed on top of the branch's last commit. git -C ${dest} diff HEAD~1 shows only the uncommitted part.`,
    )
  } else
    console.log(
      `\nNo uncommitted work was saved (it was all committed). Check out a branch: git -C ${dest} checkout refs/wip/<machine>/heads/<branch>`,
    )
  return 0
}
