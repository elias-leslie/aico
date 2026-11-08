// `aico commit -m MSG --paths ...`: the quick check on exactly the changed files under those
// paths, then a commit of only them (`git commit --only`), then the caller's leases on them are
// released. Other files, staged or not, are never touched. It refuses to take a file another
// agent wrote (an explicit file only when a named agent wrote it; a file swept in by a directory
// or glob when anyone else did) and yields to another agent's hold or a live deploy.

import { existsSync, lstatSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { type CheckReport, runCheck } from './check'
import { type CleanRun, cleanRerun } from './clean-check'
import { blobIds, changedFiles, commonDir, git, gitOk } from './git'
import type { Coordination } from './hook'
import { noteLocalCheck } from './local-check'
import type { Config } from './plan'
import { receiptStore, type StepResult, sourceKey } from './run'

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

/** The session a commit came from, the id `sessions send` takes (the hook's own order). */
const SESSION_ENV = [
  'ST_SESSION_ID',
  'CLAUDE_SESSION_ID',
  'CLAUDE_CODE_SESSION_ID',
  'CODEX_SESSION_ID',
  'CODEX_THREAD_ID',
  'PI_SESSION_ID',
  'ANTIGRAVITY_CONVERSATION_ID',
]

/** Who to tell when this commit later stops a deploy. Losing it only loses that message. */
function recordSession(root: string, sha: string, env: NodeJS.ProcessEnv): void {
  const session = SESSION_ENV.map((name) => env[name]).find(Boolean)
  if (!session) return
  try {
    receiptStore(root).put(`commit-session-${sha}`, { session })
  } catch {}
}

const named = (files: string[]) =>
  `${files.slice(0, 5).join(', ')}${files.length > 5 ? `, +${files.length - 5} more` : ''}`

export async function commit(config: Config, options: CommitOptions): Promise<CommitResult> {
  const { root } = config
  const out = options.out ?? (() => {})
  if (!options.message.trim()) throw new CommitError('a commit message is required (-m)')
  if (!options.paths.length) throw new CommitError('name the paths to commit (--paths)')
  const { files, swept } = selection(root, options.paths)
  if (!files.length) throw new CommitError(`nothing to commit under ${options.paths.join(' ')}`)
  const refused = refusals(files, swept, options.coordination.foreign(root, files, options.withAck))
  if (refused.length)
    throw new CommitError(
      `commit refused: another agent's uncommitted work: ${refused.join('; ')}. Commit your own files by name, or ask that agent (st sessions send) and rerun with --with-ack <id> once it says yes.`,
    )
  const blocked = options.coordination.guard(root, 'commit', options.withAck)
  if (blocked) throw new CommitError(blocked)

  const before = blobIds(root, files)
  const head = () =>
    gitOk(root, ['rev-parse', '--verify', 'HEAD']) ? git(root, ['rev-parse', 'HEAD']).trim() : null
  const checkedBase = head()
  const notMine = (changed: string[]) => changed.filter((file) => !files.includes(file))
  const dirtyAtStart = notMine(changedFiles(root))
  let checkedCandidate = !dirtyAtStart.length
  let report: CheckReport | null = null
  let clean: CleanRun | null = null
  if (!options.noCheck) {
    // A commit shows what failed and the verdict, not every passing or skipped stage.
    const shown = (line: string) => {
      if (!/^CHECK:(OK|SKIP):/.test(line)) out(line)
    }
    // Beside other agents' files a failure may be theirs: hold it until that's known.
    const held: string[] = []
    const env = { ...(options.env ?? process.env), ST_CHECK_CHANGED_FILES: '' }
    report = await runCheck(config, {
      lane: 'quick',
      paths: files,
      jobs: options.jobs,
      out: dirtyAtStart.length ? (line) => held.push(line) : shown,
      env,
    })
    const flush = () => {
      for (const line of held) shown(line)
    }
    if (report.passed) flush()
    else {
      const others = [...new Set([...dirtyAtStart, ...notMine(changedFiles(root))])]
      const failed = report.results.filter(
        (result) => result.required && !['pass', 'skip'].includes(result.state),
      )
      if (others.length) {
        try {
          clean = await cleanRerun(config, failed, files, { jobs: options.jobs, out: shown, env })
        } catch (error) {
          flush()
          throw new CommitError(
            `commit refused: the quick check failed (details above), and a clean copy of HEAD plus your files could not be set up (${(error as Error).message}). Check your own files (st check <tool> -- FILE), then rerun with --skip-checks.`,
          )
        }
      }
      if (!clean) {
        flush()
        throw new CommitError('commit refused: the quick check failed (details above)')
      }
      if (clean.results.some((r) => r.required && !['pass', 'skip'].includes(r.state)))
        throw new CommitError(
          `commit refused: the quick check failed on HEAD plus your files alone (details above); other agents' work is not the cause`,
        )
      out(
        `CHECK:CLEAN:${failed.map((r) => r.id).join(', ')} failed only on other agents' unfinished work (${named(others)}); passed on HEAD plus your files`,
      )
      const rerun = new Map(clean.results.map((result) => [result.id, result]))
      report = {
        ...report,
        passed: true,
        // The clean tree is gone: its stages are held to HEAD below, not to the working tree.
        results: report.results.map((result) =>
          rerun.has(result.id)
            ? { ...(rerun.get(result.id) as StepResult), inputs: undefined }
            : result,
        ),
      }
      checkedCandidate = false
    }
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
    // A clean stage saw HEAD plus the named files, which are watched above: only HEAD can move.
    for (const result of clean?.results ?? []) {
      if (
        clean &&
        result.inputs &&
        git(root, ['diff', '--name-only', clean.base, 'HEAD', '--', ...result.inputs.paths]).trim()
      )
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
    const refused = refusals(
      files,
      swept,
      options.coordination.foreign(root, files, options.withAck),
    )
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
    const literal = (paths: string[]) => paths.map((file) => `:(literal)${file}`)
    // Untracked with git rm --cached but kept on disk: in HEAD, not in the index, still present.
    const inHead = gitOk(root, ['rev-parse', '-q', '--verify', 'HEAD'])
      ? new Set(
          git(root, ['ls-tree', '-r', '-z', '--name-only', 'HEAD', '--', ...literal(files)])
            .split('\0')
            .filter(Boolean),
        )
      : new Set<string>()
    const untrack = files.filter(
      (file) => inHead.has(file) && !indexed.has(file) && present(join(root, file)),
    )
    const stage = files.filter(
      (file) => !untrack.includes(file) && (indexed.has(file) || present(join(root, file))),
    )
    if (stage.length) git(root, ['add', '-A', '--', ...literal(stage)])
    if (!untrack.length) {
      git(
        root,
        ['commit', '--only', '-q', '-F', '-', '--', ...literal(files)],
        shortSubject(options.message),
      )
    } else {
      // git commit --only would take an untracked file back from the working tree, so the
      // commit is built in a scratch index: HEAD, plus these paths as the real index has them.
      const index = resolve(
        root,
        git(root, ['rev-parse', '--git-path', 'aico-commit-index']).trim(),
      )
      const env = { ...process.env, GIT_INDEX_FILE: index }
      try {
        git(root, ['read-tree', 'HEAD'], undefined, env)
        const take = files.filter(
          (file) => !untrack.includes(file) && (inHead.has(file) || present(join(root, file))),
        )
        if (take.length) git(root, ['add', '-A', '--', ...literal(take)], undefined, env)
        git(root, ['rm', '-q', '--cached', '--', ...literal(untrack)], undefined, env)
        git(root, ['commit', '-q', '-F', '-'], shortSubject(options.message), env)
      } finally {
        rmSync(index, { force: true })
      }
    }
    return git(root, ['rev-parse', 'HEAD']).trim()
  })
  recordSession(root, sha, options.env ?? process.env)
  const tree = git(root, ['rev-parse', `${sha}^{tree}`]).trim()
  if (report && checkedCandidate && !changedFiles(root).length)
    noteLocalCheck(root, sha, report, out)
  out(`COMMIT[1]:status=SUCCESS pushed=false detail=${sha}`)
  const released = options.coordination.committed(root, files)
  if (released) out(released)
  return { sha, tree, files, check: report }
}
