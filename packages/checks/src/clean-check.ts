// When a commit's quick check fails and other files are dirty, the stages that failed run again on
// what the commit would actually make: a clean worktree of HEAD plus the committed files. Nothing
// here touches the checkout, its index or its stashes; the worktree is always removed.

import { copyFileSync, lstatSync, mkdirSync, readlinkSync, rmSync, symlinkSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { withWorktree } from './accept'
import { trackedFiles } from './check'
import { git, gitOk } from './git'
import { type Config, plan } from './plan'
import { runSteps, type StepResult } from './run'

export interface CleanRun {
  /** The HEAD it ran on. */
  base: string
  results: StepResult[]
}

const literal = (paths: string[]) => paths.map((file) => `:(literal)${file}`)

/** Puts the bytes the commit takes into the tree; a file the commit removes or untracks goes. */
function applyFiles(main: string, work: string, files: string[]): void {
  const indexed = new Set(
    git(main, ['ls-files', '-z', '--', ...literal(files)])
      .split('\0')
      .filter(Boolean),
  )
  const inHead = new Set(
    git(main, ['ls-tree', '-r', '-z', '--name-only', 'HEAD', '--', ...literal(files)])
      .split('\0')
      .filter(Boolean),
  )
  for (const file of files) {
    const from = join(main, file)
    const to = join(work, file)
    const stat = lstatSync(from, { throwIfNoEntry: false })
    rmSync(to, { force: true })
    // Untracked with git rm --cached: on disk, but the commit takes it out of HEAD.
    if (!stat || (inHead.has(file) && !indexed.has(file))) continue
    mkdirSync(dirname(to), { recursive: true })
    if (stat.isSymbolicLink()) symlinkSync(readlinkSync(from), to)
    else copyFileSync(from, to)
  }
}

/** The failed stages can be judged again only when each is a planned stage that didn't fail on a race. */
function rerunnable(failed: StepResult[]): boolean {
  return failed.every((result) => !result.reason?.startsWith('source_changed_during_checks'))
}

/**
 * The failed stages on HEAD plus files, or null when they aren't stages to rerun. Throws when the
 * clean tree can't be set up.
 */
export async function cleanRerun(
  config: Config,
  failed: StepResult[],
  files: string[],
  options: { jobs?: number; out: (line: string) => void; env?: NodeJS.ProcessEnv },
): Promise<CleanRun | null> {
  const main = config.root
  if (!rerunnable(failed) || !gitOk(main, ['rev-parse', '-q', '--verify', 'HEAD'])) return null
  const base = git(main, ['rev-parse', 'HEAD']).trim()
  const ids = new Set(failed.map((result) => result.id))
  const results = await withWorktree(
    config,
    base,
    async (work, worked) => {
      const planned = plan(worked, 'quick', files, () => trackedFiles(work)).filter((item) =>
        ids.has(item.id),
      )
      // A failure that is no planned stage (the roadmap rule) stays a failure of this commit.
      if (planned.filter((item) => item.step).length !== ids.size) return null
      return runSteps(worked, 'quick', planned, {
        jobs: options.jobs,
        out: options.out,
        detailsRoot: main,
        env: options.env,
      })
    },
    (work) => applyFiles(main, work, files),
  )
  return results && { base, results }
}
