// `aico check` and `aico commit`.
// Exit codes: 0 passed or committed, 1 failed or refused, 2 usage, 3 this repo's checks are not
// run by aico (no [native] gate, or a tool it does not run): `st check` then keeps the repo.

import { existsSync } from 'node:fs'
import { relative, resolve } from 'node:path'
import { accept } from './accept'
import { runCheck, trackedFiles } from './check'
import { CommitError, commit } from './commit'
import { GitError, repoPaths, repoRoot } from './git'
import { type Coordination, CoordinationError } from './hook'
import { ConfigError, LEGACY, loadConfig, type Planned, plan, toolDir } from './plan'
import { passed, runSteps } from './run'
import type { CheckSummary } from './status'

export interface CliIo {
  out(line: string): void
  err(line: string): void
  cwd: string
  env: NodeJS.ProcessEnv
  coordination: Coordination
  /** Records the result on Status (best effort; tests leave it out). */
  report?(root: string, summary: CheckSummary): Promise<string | null>
  /** Starts the copy of this repo on the other full machines after a commit (best effort; tests leave it out). */
  copy?(root: string): void
}

const CHECK_USAGE = `aico check: the repo's gate (.st-check.toml).
  aico check --quick [--changed-only]     the fast lane on your own changed files (commit runs it)
  aico check [--changed-only]             the full gate on the working tree
  aico check --fix [--paths P...]         Biome and ruff fixes on your own changed files only
  aico check TOOL -- [ARGS...]           one configured tool (vitest, pytest, ruff, types, biome, tsc)
  aico check --native --stage ID          one declared native stage (--no-reuse, --json)
  aico check --acceptance [--sha REV]     the full gate on a commit, in a clean worktree
  options: --paths P...  scope to the changed files under P; --no-reuse  rerun a pass on identical
  content; --jobs N  stages at once (default 3); --with-ack ID  a holder's yes for acceptance
Your own changed files: the dirty files no other session wrote or leases.`

const COMMIT_USAGE = `aico commit -m MSG --paths P... [--with-ack ID] [--skip-checks]
  Runs the quick check on the changed files under P, commits only them, and releases your leases on them.`

interface Parsed {
  flags: Set<string>
  values: Map<string, string>
  paths: string[]
  extra: string[]
}

/** --paths takes several values (--paths a b) or repeats; other value options take one. */
function parse(argv: string[], valued: string[]): Parsed {
  const parsed: Parsed = { flags: new Set(), values: new Map(), paths: [], extra: [] }
  for (let i = 0; i < argv.length; i++) {
    const [arg, inline] =
      argv[i].includes('=') && argv[i].startsWith('--') ? argv[i].split(/=(.*)/s) : [argv[i]]
    if (arg === '--paths' || arg === '--path') {
      if (inline !== undefined) parsed.paths.push(inline)
      while (i + 1 < argv.length && !argv[i + 1].startsWith('-')) parsed.paths.push(argv[++i])
    } else if (valued.includes(arg)) {
      const value = inline ?? argv[++i]
      if (value === undefined) throw new CommitError(`${arg} needs a value`)
      parsed.values.set(arg, value)
    } else if (arg.startsWith('-')) parsed.flags.add(arg)
    else parsed.extra.push(arg)
  }
  return parsed
}

/** The repo and its gate; outside a git repo the gate is unsupported too (exit 3). */
function load(io: CliIo): { root: string; config: ReturnType<typeof loadConfig> } {
  let root: string
  try {
    root = repoRoot(io.cwd)
  } catch {
    return { root: io.cwd, config: { unsupported: 'not in a git repository' } }
  }
  return { root, config: loadConfig(root) }
}

async function checkCli(argv: string[], io: CliIo): Promise<number> {
  const tool = argv[0]
  const native = argv.includes('--native') || argv.includes('--stage')
  if (native || (LEGACY as readonly string[]).includes(tool)) {
    const { root, config } = load(io)
    if ('unsupported' in config) {
      io.err(`aico check: ${config.unsupported}`)
      return 2
    }
    let selected: Planned[]
    let reuse = true,
      json = false
    if (native) {
      const args = parse(argv, ['--stage'])
      const unknown = [...args.flags].filter(
        (flag) => !['--native', '--no-reuse', '--json'].includes(flag),
      )
      if (unknown.length || args.extra.length)
        throw new ConfigError('native checks accept --stage ID, --no-reuse and --json')
      const id = args.values.get('--stage')
      if (!id)
        return checkCli(
          argv.filter((arg) => arg !== '--native' && arg !== '--json'),
          io,
        )
      const stage = config.stages.find((item) => item.id === id)
      if (!stage) throw new ConfigError(`No declared check stage ${id}`)
      selected = plan(
        { ...config, legacy: [], stages: [{ ...stage, coveredBy: undefined }] },
        'full',
        null,
        () => trackedFiles(root),
      )
      reuse = !args.flags.has('--no-reuse')
      json = args.flags.has('--json')
    } else {
      selected = plan(
        { ...config, legacyDefault: false, legacy: [tool], stages: [] },
        'full',
        null,
        () => trackedFiles(root),
      )
      const extra = argv.slice(argv[1] === '--' ? 2 : 1).map((arg) => {
        if (arg.startsWith('-') || !existsSync(resolve(root, arg))) return arg
        const cwd = toolDir(root, tool)
        return relative(resolve(root, cwd), resolve(root, arg)) || '.'
      })
      selected = selected.map((item) => {
        if (!item.step) return item
        let base = item.step.argv
        let args = extra
        if (tool === 'biome' && extra.some((arg) => !arg.startsWith('-')))
          base = base.filter((arg) => arg !== '.')
        if (tool === 'vitest' && extra[0] === 'related') {
          base = [base[0], ...extra, ...base.slice(2)]
          args = []
        }
        if (tool === 'pytest' && extra.some((arg) => arg && !arg.startsWith('-'))) {
          base = [base[0], '-q', '--tb=short']
          if (
            config.pytestNoCov &&
            !extra.some((arg) => arg === '--no-cov' || arg.startsWith('--cov'))
          )
            args = ['--no-cov', ...extra]
        } else if (
          tool === 'pytest' &&
          extra.some(
            (arg) =>
              arg.endsWith('no:xdist') || arg.startsWith('-n') || arg.startsWith('--numprocesses'),
          )
        )
          base = [base[0], '-q', '--tb=short']
        return { ...item, step: { ...item.step, argv: [...base, ...args] } }
      })
    }
    const results = await runSteps(config, 'full', selected, {
      out: json ? undefined : io.out,
      reuse,
      env: io.env,
    })
    const ok = passed(results)
    io.out(
      json
        ? JSON.stringify({ state: ok ? 'pass' : 'fail', stages: results })
        : `CHECK:${ok ? 'PASS' : 'FAIL'} focused (${results.length} stage(s))`,
    )
    return ok ? 0 : 1
  }
  const args = parse(argv, ['--sha', '--jobs', '--with-ack', '--scope'])
  if (args.flags.has('--help') || args.flags.has('-h')) {
    io.out(CHECK_USAGE)
    return 0
  }
  const known = ['--quick', '--changed-only', '--acceptance', '--fix', '--no-reuse', '--check']
  const unknown = [...args.flags].filter((flag) => !known.includes(flag))
  if (unknown.length || args.extra.length) {
    io.err(`aico check: unsupported ${[...unknown, ...args.extra].join(' ')}`)
    io.err(CHECK_USAGE)
    return 2
  }
  const { root, config } = load(io)
  if ('unsupported' in config) {
    if (!io.env.AICO_CHECKS_CALLER)
      io.err(
        `aico check: this repo's gate is not run by aico (${config.unsupported}); use st check`,
      )
    return 3
  }
  const jobs = args.values.has('--jobs') ? Number(args.values.get('--jobs')) : undefined
  const reuse = !args.flags.has('--no-reuse')
  let summary: CheckSummary
  if (args.flags.has('--acceptance')) {
    const report = await accept(config, {
      sha: args.values.get('--sha'),
      coordination: io.coordination,
      withAck: args.values.get('--with-ack'),
      reuse,
      jobs,
      out: io.out,
      env: io.env,
    })
    summary = {
      lane: 'acceptance',
      passed: report.passed,
      results: report.results,
      ms: report.ms,
      sha: report.sha,
    }
  } else {
    const report = await runCheck(config, {
      lane: args.flags.has('--quick') ? 'quick' : 'full',
      changedOnly: args.flags.has('--changed-only'),
      paths: args.paths.length ? repoPaths(root, io.cwd, args.paths) : undefined,
      fix: args.flags.has('--fix'),
      reuse,
      jobs,
      out: io.out,
      coordination: io.coordination,
      env: io.env,
    })
    summary = { lane: report.lane, passed: report.passed, results: report.results, ms: report.ms }
  }
  const note = await io.report?.(root, summary)
  if (note) io.err(note)
  return summary.passed ? 0 : 1
}

async function commitCli(argv: string[], io: CliIo): Promise<number> {
  const args = parse(argv, ['-m', '--message', '--msg', '--with-ack', '--jobs'])
  if (args.flags.has('--help') || args.flags.has('-h')) {
    io.out(COMMIT_USAGE)
    return 0
  }
  const unknown = [...args.flags].filter((flag) => !['--skip-checks', '--no-push'].includes(flag))
  const message = args.values.get('-m') ?? args.values.get('--message') ?? args.values.get('--msg')
  if (unknown.length || args.extra.length || !message || !args.paths.length) {
    io.err(
      unknown.length || args.extra.length
        ? `aico commit: unsupported ${[...unknown, ...args.extra].join(' ')}`
        : 'aico commit: -m MSG and --paths are required',
    )
    io.err(COMMIT_USAGE)
    return 2
  }
  // The launcher checks arguments before it queues for the heavy-work lane.
  if (io.env.AICO_CHECKS_ARGS_ONLY) return 0
  const { root, config } = load(io)
  if ('unsupported' in config) {
    if (!io.env.AICO_CHECKS_CALLER)
      io.err(
        `aico commit: this repo's gate is not run by aico (${config.unsupported}); use st commit`,
      )
    return 3
  }
  const result = await commit(config, {
    message,
    paths: repoPaths(root, io.cwd, args.paths),
    coordination: io.coordination,
    withAck: args.values.get('--with-ack'),
    noCheck: args.flags.has('--skip-checks'),
    jobs: args.values.has('--jobs') ? Number(args.values.get('--jobs')) : undefined,
    out: io.out,
    env: io.env,
  })
  if (result.check) {
    const note = await io.report?.(root, {
      lane: 'quick',
      passed: true,
      results: result.check.results,
      ms: result.check.ms,
    })
    if (note) io.err(note)
  }
  io.copy?.(root)
  return 0
}

/** Runs one verb, turning the expected refusals into a message and exit 1. */
export async function runCli(verb: 'check' | 'commit', argv: string[], io: CliIo): Promise<number> {
  try {
    return await (verb === 'check' ? checkCli(argv, io) : commitCli(argv, io))
  } catch (error) {
    if (
      error instanceof CommitError ||
      error instanceof ConfigError ||
      error instanceof CoordinationError ||
      error instanceof GitError
    ) {
      io.err(`${verb === 'commit' ? 'ERROR: ' : 'aico check: '}${error.message}`)
      return 1
    }
    throw error
  }
}
