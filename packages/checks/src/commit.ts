// `aico commit -m MSG --paths ...`: the quick check on exactly the changed files under those
// paths, then a commit of only them (`git commit --only`), then the caller's leases on them are
// released. Other files, staged or not, are never touched. It refuses to take a file another
// agent wrote (an explicit file only when a named agent wrote it; a file swept in by a directory
// or glob when anyone else did) and yields to another agent's hold or a live deploy.

import { existsSync, lstatSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { type CheckReport, runCheck } from './check'
import { blobIds, changedFiles, commonDir, git, gitOk } from './git'
import type { Coordination } from './hook'
import { noteLocalCheck } from './local-check'
import type { Config } from './plan'
import { sourceKey } from './run'

export class CommitError extends Error {}

/** On disk, a dangling symlink included. */
function present(path: string): boolean {
  try {
    lstatSync(path)
    return true
  } catch {
    return false
  }
}

export interface CommitOptions {
  message: string
  /** Repo-relative pathspecs. */
  paths: string[]
  coordination: Coordination
  withAck?: string
  /** Skip the quick check (tests, or a caller that just ran the same check). */
  noCheck?: boolean
  jobs?: number
  out?: (line: string) => void
  env?: NodeJS.ProcessEnv
}

export interface CommitResult {
  sha: string
  tree: string
  files: string[]
  check: CheckReport | null
}

/** Preserve the caller's subject, body and trailers, regardless of subject length. */
export function shortSubject(message: string): string {
  return message.trim()
}

/** The files a commit of these pathspecs takes, and the ones swept in by a directory or glob. */
export function selection(root: string, paths: string[]): { files: string[]; swept: Set<string> } {
  const files = changedFiles(root, paths)
  const explicit = new Set(paths)
  return { files, swept: new Set(files.filter((file) => !explicit.has(file))) }
}

/** The files that are another agent's work: why the commit refuses them. */
export function refusals(
  files: string[],
  swept: Set<string>,
  foreign: Record<string, string[]>,
): string[] {
  const lines: string[] = []
  for (const file of files) {
    const writers = (foreign[file] ?? []).filter((id) => !id.startsWith('lease:'))
    const named = writers.filter((id) => id !== 'unknown')
    if (named.length) lines.push(`${file} (written by ${named.join(', ')})`)
    else if (swept.has(file) && writers.length)
      lines.push(`${file} (written by another session; name it explicitly to take it)`)
  }
  return lines
}

/** One commit at a time per repo: a lock dir under the shared .git, taken over when its owner died. */
async function withRepoLock<T>(root: string, fn: () => T): Promise<T> {
  const dir = join(commonDir(root), 'aico-checks')
  mkdirSync(dir, { recursive: true })
  const lock = join(dir, 'commit.lock')
  const deadline = Date.now() + 300_000
  for (;;) {
    try {
      mkdirSync(lock)
      writeFileSync(join(lock, 'pid'), String(process.pid))
      break
    } catch {
      let owner = 0
      try {
        owner = Number(readFileSync(join(lock, 'pid'), 'utf8'))
      } catch {}
      let alive = owner > 0
      try {
        if (owner) process.kill(owner, 0)
      } catch {
        alive = false
      }
      if (!alive && existsSync(lock)) {
        rmSync(lock, { recursive: true, force: true })
        continue
      }
      if (Date.now() > deadline)
        throw new CommitError('another commit in this repo held the lock for 5 minutes')
      await new Promise((resolve) => setTimeout(resolve, 200))
    }
  }
  try {
    return fn()
  } finally {
    rmSync(lock, { recursive: true, force: true })
  }
}

export async function commit(config: Config, options: CommitOptions): Promise<CommitResult> {
  const { root } = config
  const out = options.out ?? (() => {})
  if (!options.message.trim()) throw new CommitError('a commit message is required (-m)')
  if (!options.paths.length) throw new CommitError('name the paths to commit (--paths)')
  const { files, swept } = selection(root, options.paths)
  if (!files.length) throw new CommitError(`nothing to commit under ${options.paths.join(' ')}`)
  const refused = refusals(files, swept, options.coordination.foreign(root, files))
  if (refused.length)
    throw new CommitError(
      `commit refused: another agent's uncommitted work: ${refused.join('; ')}. Commit your own files by name, or ask that agent (aico sessions send).`,
    )
  const blocked = options.coordination.guard(root, 'commit', options.withAck)
  if (blocked) throw new CommitError(blocked)

  const before = blobIds(root, files)
  const head = () =>
    gitOk(root, ['rev-parse', '--verify', 'HEAD']) ? git(root, ['rev-parse', 'HEAD']).trim() : null
  const checkedBase = head()
  let checkedCandidate = changedFiles(root).every((file) => files.includes(file))
  let report: CheckReport | null = null
  if (!options.noCheck) {
    report = await runCheck(config, {
      lane: 'quick',
      paths: files,
      jobs: options.jobs,
      // A commit shows what failed and the verdict, not every passing or skipped stage.
      out: (line) => {
        if (!/^CHECK:(OK|SKIP):/.test(line)) out(line)
      },
      env: { ...(options.env ?? process.env), ST_CHECK_CHANGED_FILES: '' },
    })
    if (!report.passed)
      throw new CommitError('commit refused: the quick check failed (details above)')
  }
  const after = blobIds(root, files)
  const moved = files.filter((file) => before.get(file) !== after.get(file))
  if (moved.length)
    throw new CommitError(`source changed during the check: ${moved.join(', ')}; rerun the commit`)

  const verifyInputs = () => {
    for (const result of report?.results ?? []) {
      if (result.inputs && sourceKey(root, result.inputs.paths) !== result.inputs.key)
        throw new CommitError(
          `source changed during the check: stage ${result.id} inputs; rerun the commit`,
        )
    }
  }
  verifyInputs()

  const sha = await withRepoLock(root, () => {
    verifyInputs()
    // A different commit may have held the lock after the check finished.
    const current = blobIds(root, files)
    const moved = files.filter((file) => before.get(file) !== current.get(file))
    if (moved.length)
      throw new CommitError(
        `source changed while waiting to commit: ${moved.join(', ')}; rerun the commit`,
      )
    const refused = refusals(files, swept, options.coordination.foreign(root, files))
    if (refused.length)
      throw new CommitError(
        `commit refused: another agent's uncommitted work: ${refused.join('; ')}`,
      )
    const blocked = options.coordination.guard(root, 'commit', options.withAck)
    if (blocked) throw new CommitError(blocked)
    checkedCandidate &&=
      head() === checkedBase && changedFiles(root).every((file) => files.includes(file))
    // A deletion already staged (git rm, git mv) is in neither the tree nor the index: git add
    // refuses its path, and git commit --only takes it as it is.
    const indexed = new Set(
      git(root, ['ls-files', '-z', '--', ...files.map((file) => `:(literal)${file}`)])
        .split('\0')
        .filter(Boolean),
    )
    const stage = files.filter((file) => indexed.has(file) || present(join(root, file)))
    if (stage.length) git(root, ['add', '-A', '--', ...stage.map((file) => `:(literal)${file}`)])
    git(
      root,
      ['commit', '--only', '-q', '-F', '-', '--', ...files.map((file) => `:(literal)${file}`)],
      shortSubject(options.message),
    )
    return git(root, ['rev-parse', 'HEAD']).trim()
  })
  const tree = git(root, ['rev-parse', `${sha}^{tree}`]).trim()
  if (report && checkedCandidate && !changedFiles(root).length)
    noteLocalCheck(root, sha, report, out)
  out(`COMMIT[1]:status=SUCCESS pushed=false detail=${sha}`)
  out(options.coordination.committed(root, files))
  return { sha, tree, files, check: report }
}
