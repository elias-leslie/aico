// `aico check --repair STAGE,...`: a deploy's acceptance failed on Biome or ruff stages. Runs their
// safe fixes in a throwaway worktree of HEAD, so a fixer never meets anyone's unsaved work, then
// takes a fixed file into the checkout only while the checkout still has HEAD's version of it, and
// commits exactly those. A dirty file is left alone: its failure goes to whoever owns it.

import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { basename, join } from 'node:path'
import { withWorktree } from './accept'
import { fixScope, trackedFiles } from './check'
import { CommitError, commit } from './commit'
import { blobIds, changedFiles, git } from './git'
import type { Coordination } from './hook'
import type { Config } from './plan'

const FIXERS = ['biome', 'ruff']

export interface RepairOptions {
  coordination: Coordination
  withAck?: string
  out?: (line: string) => void
  env?: NodeJS.ProcessEnv
}

/** What the fixers changed in a clean copy of base, among files nobody has changed. */
function fixesAt(
  config: Config,
  base: string,
  stages: string[],
): Promise<{ file: string; text: Buffer }[]> {
  const dirty = new Set(changedFiles(config.root))
  const clean = trackedFiles(config.root).filter((file) => !dirty.has(file))
  return withWorktree(config, base, async (work, worked) => {
    for (const stage of worked.stages) {
      const tool = basename(stage.argv[0])
      if (!stages.includes(stage.id) || !FIXERS.includes(tool)) continue
      // The paths the stage itself checks: a file outside its gate isn't its to rewrite.
      const dirs = stage.argv
        .slice(1)
        .filter((arg) => !arg.startsWith('-') && existsSync(join(work, stage.cwd, arg)))
      const inStage = clean.filter((file) =>
        dirs.some((dir) => dir === '.' || file === dir || file.startsWith(`${dir}/`)),
      )
      for (const command of fixScope(worked, inStage).filter((c) => c.tool === tool))
        spawnSync(command.argv[0], command.argv.slice(1), {
          cwd: join(work, command.cwd),
          stdio: 'ignore',
        })
    }
    return git(work, ['diff', '--name-only', '-z'])
      .split('\0')
      .filter(Boolean)
      .map((file) => ({ file, text: readFileSync(join(work, file)) }))
  })
}

/** The commit holding the fixes, or null when nothing could be fixed or committed. */
export async function repairStages(
  config: Config,
  stages: string[],
  options: RepairOptions,
): Promise<string | null> {
  const { root } = config
  const out = options.out ?? (() => {})
  const base = git(root, ['rev-parse', 'HEAD']).trim()
  const fixes = await fixesAt(config, base, stages)
  const blobAtBase = (file: string) => git(root, ['rev-parse', `${base}:${file}`]).trim()
  const current = blobIds(
    root,
    fixes.map((fix) => fix.file),
  )
  // Saved since the fixer read it: that file is someone's now.
  const taken = fixes.filter((fix) => current.get(fix.file) === blobAtBase(fix.file))
  if (!taken.length) return null
  const files = taken.map((fix) => fix.file)
  for (const fix of taken) writeFileSync(join(root, fix.file), fix.text)
  const written = blobIds(root, files)
  /** Only our own rewrite goes back; a file someone saved since then stays theirs. */
  const undo = () => {
    const now = blobIds(root, files)
    const ours = files.filter((file) => written.get(file) === now.get(file))
    if (ours.length) git(root, ['restore', '--worktree', `--source=${base}`, '--', ...ours])
  }
  try {
    const { sha } = await commit(config, {
      message: `Deploy: safe format and lint fixes in ${files.length} file(s) the checks refused`,
      paths: files,
      noCheck: true, // the acceptance that follows judges this very commit
      coordination: options.coordination,
      withAck: options.withAck,
      out,
      env: options.env,
    })
    return sha
  } catch (error) {
    undo()
    if (!(error instanceof CommitError)) throw error
    out(`REPAIR:not committed: ${error.message}`)
    return null
  }
}
