// `aico check --acceptance [--sha REV]`: the full gate on a committed tree, in a throwaway git
// worktree of that commit, so nobody's uncommitted edits count. The ignored runtime inputs
// (node_modules, the venvs [paths] names) come from the main checkout as links; links to the
// repo's own workspace packages point into the worktree, so the commit's own source is what runs.
// A pass is kept per tree id: the same tree is accepted once.

import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readlinkSync,
  realpathSync,
  rmSync,
  symlinkSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, relative, resolve } from 'node:path'
import type { CheckReport } from './check'
import { trackedFiles } from './check'
import { git, gitOk } from './git'
import type { Coordination } from './hook'
import { type Config, ConfigError, loadConfig, plan } from './plan'
import { passed, receiptStore, runSteps } from './run'

export interface AcceptOptions {
  sha?: string
  coordination: Coordination
  withAck?: string
  reuse?: boolean
  jobs?: number
  out?: (line: string) => void
}

export interface AcceptReport extends CheckReport {
  sha: string
  tree: string
}

const inside = (path: string, dir: string) => path === dir || path.startsWith(`${dir}/`)

/** node_modules dirs of the main checkout (the root one and each package's), never nested ones. */
function moduleDirs(root: string, names: string[]): string[] {
  const found: string[] = []
  const walk = (rel: string, depth: number) => {
    for (const entry of readdirSync(join(root, rel), { withFileTypes: true })) {
      if (!(entry.isDirectory() || entry.isSymbolicLink()) || entry.name === '.git') continue
      const path = rel ? `${rel}/${entry.name}` : entry.name
      if (names.includes(entry.name)) found.push(path)
      else if (entry.isDirectory() && depth < 3 && !entry.name.startsWith('.'))
        walk(path, depth + 1)
    }
  }
  walk('', 0)
  return found
}

/**
 * Recreates dir (a node_modules of main) in the worktree as links to main's entries; a link into
 * main's own source (a workspace package) points at the same path in the worktree instead.
 */
function linkModules(main: string, work: string, dir: string): void {
  const from = join(main, dir)
  const to = join(work, dir)
  mkdirSync(to, { recursive: true })
  for (const entry of readdirSync(from, { withFileTypes: true })) {
    const source = join(from, entry.name)
    const target = join(to, entry.name)
    if (entry.isDirectory() && entry.name.startsWith('@')) {
      linkModules(main, work, join(dir, entry.name))
      continue
    }
    if (entry.isSymbolicLink()) {
      let real: string
      try {
        real = realpathSync(source)
      } catch {
        continue
      }
      if (inside(real, main) && !real.split('/').includes('node_modules')) {
        symlinkSync(relative(dirname(target), join(work, relative(main, real))), target)
        continue
      }
      symlinkSync(resolve(dirname(source), readlinkSync(source)), target)
      continue
    }
    symlinkSync(source, target)
  }
}

/** Links the main checkout's prepared runtime inputs into the worktree. */
export function linkEnvironment(config: Config, work: string): void {
  const main = config.root
  const names = config.environmentInputs.filter((input) => !input.includes('/'))
  for (const dir of moduleDirs(main, names)) {
    if (existsSync(join(work, dir))) continue
    if (dir.split('/').pop() === 'node_modules') linkModules(main, work, dir)
    else symlinkSync(join(main, dir), join(work, dir))
  }
  for (const input of config.environmentInputs.filter((input) => input.includes('/'))) {
    if (!existsSync(join(main, input)) || existsSync(join(work, input))) continue
    mkdirSync(dirname(join(work, input)), { recursive: true })
    symlinkSync(join(main, input), join(work, input))
  }
}

export async function accept(config: Config, options: AcceptOptions): Promise<AcceptReport> {
  const main = config.root
  const out = options.out ?? (() => {})
  const blocked = options.coordination.guard(main, 'acceptance', options.withAck)
  if (blocked) throw new ConfigError(blocked)
  const rev = options.sha ?? 'HEAD'
  if (!gitOk(main, ['rev-parse', '-q', '--verify', `${rev}^{commit}`]))
    throw new ConfigError(`no commit ${rev}`)
  const sha = git(main, ['rev-parse', `${rev}^{commit}`]).trim()
  const tree = git(main, ['rev-parse', `${sha}^{tree}`]).trim()
  const store = receiptStore(main)
  const key = `accept-${tree}`
  const prior = store.get<AcceptReport & { at?: string }>(key)
  if (options.reuse !== false && prior?.passed) {
    out(
      `CHECK:PASS acceptance reused: tree ${tree.slice(0, 12)} passed at ${prior.at ?? 'an earlier run'}`,
    )
    return { ...prior, sha, reused: true }
  }
  const started = performance.now()
  const parent = mkdtempSync(join(tmpdir(), 'aico-accept-'))
  const work = join(parent, 'tree')
  git(main, ['worktree', 'add', '--detach', '-q', work, sha])
  try {
    const loaded = loadConfig(work)
    if ('unsupported' in loaded) throw new ConfigError(`acceptance: ${loaded.unsupported}`)
    const worked: Config = { ...loaded, environmentInputs: config.environmentInputs }
    linkEnvironment(config, work)
    out(`CHECK:acceptance:${sha.slice(0, 12)} (tree ${tree.slice(0, 12)})`)
    const results = await runSteps(
      worked,
      'full',
      plan(worked, 'full', null, () => trackedFiles(work)),
      {
        jobs: options.jobs,
        out,
        reuse: options.reuse,
        detailsRoot: main,
      },
    )
    const report: AcceptReport = {
      lane: 'full',
      passed: passed(results),
      results,
      ms: performance.now() - started,
      scope: null,
      sha,
      tree,
    }
    const failed = results.filter(
      (result) => result.required && !['pass', 'skip'].includes(result.state),
    )
    out(
      `CHECK:${report.passed ? 'PASS' : 'FAIL'} acceptance ${(report.ms / 1000).toFixed(1)}s at ${sha.slice(0, 12)}${failed.length ? `: ${failed.map((r) => r.id).join(', ')}` : ''}`,
    )
    if (report.passed) store.put(key, { ...report, at: new Date().toISOString() })
    return report
  } finally {
    // The links go first so removing the worktree never walks into the main checkout's modules.
    for (const dir of moduleDirs(work, ['node_modules', '.venv']))
      if (lstatSync(join(work, dir)).isSymbolicLink() || dir.endsWith('node_modules'))
        rmSync(join(work, dir), { recursive: true, force: true })
    try {
      git(main, ['worktree', 'remove', '--force', work])
    } catch {
      rmSync(work, { recursive: true, force: true })
      git(main, ['worktree', 'prune'])
    }
    rmSync(parent, { recursive: true, force: true })
  }
}
