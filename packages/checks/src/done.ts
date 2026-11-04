// `aico tasks done ID`: commit the task's own paths (--paths, with the quick check), require the
// acceptance check on the resulting commit (unless --record-only, or the outcome is failed), close
// the task, and log its tree receipt: the commit's tree id and the check result.

import { parseArgs } from 'node:util'
import { type Deps, type Io, runTasks, TaskStore } from '@aico/tasks'
import { accept } from './accept'
import { commit } from './commit'
import { git, repoPaths, repoRoot } from './git'
import type { Coordination } from './hook'
import { loadConfig } from './plan'

export interface DoneDeps extends Deps {
  coordination: Coordination
  jobs?: number
}

/** The flags done acts on itself; the rest go to the task store's own done. */
const OWN = new Set(['--paths', '--path', '--record-only', '--with-ack'])

/** argv: what follows `aico tasks done`. */
export async function doneWithReceipt(argv: string[], deps: DoneDeps, io: Io): Promise<number> {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    strict: false,
    options: {
      task: { type: 'string', short: 't' },
      message: { type: 'string', short: 'm' },
      outcome: { type: 'string' },
      paths: { type: 'string', multiple: true },
      path: { type: 'string', multiple: true },
      'record-only': { type: 'boolean' },
      'with-ack': { type: 'string' },
    },
  })
  const rest: string[] = []
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i].split('=')[0]
    if (!OWN.has(flag)) rest.push(argv[i])
    else if (flag !== '--record-only' && !argv[i].includes('=')) i++
  }
  const taskId =
    (values.task as string | undefined) ?? (positionals[0] as string | undefined)?.split('.')[0]
  if (!taskId) return runTasks(['done', ...rest], deps, io)
  const task = new TaskStore(deps.db).get(taskId)
  if (!task || task.status === 'completed' || task.status === 'abandoned')
    return runTasks(['done', ...rest], deps, io)

  const withAck = values['with-ack'] as string | undefined
  const out = (line: string) => io.out(line)
  const paths = [
    ...((values.paths as string[]) ?? []),
    ...((values.path as string[]) ?? []),
  ].flatMap((p) => p.split(/\s+/).filter(Boolean))
  const failed = values.outcome === 'failed'
  const recordOnly = values['record-only'] === true || failed
  if (!paths.length && recordOnly) {
    const code = await runTasks(['done', ...rest], deps, io)
    if (code === 0)
      new TaskStore(deps.db).appendLog(taskId, 'receipt: record-only (no commit, no acceptance)')
    return code
  }
  let root: string
  try {
    root = repoRoot(deps.cwd)
  } catch {
    io.err("Task closeout blocked: run it in the task's repository (or pass --record-only)")
    return 1
  }
  const config = loadConfig(root)
  if ('unsupported' in config) {
    io.err(
      `Task closeout blocked: this repo's checks are not run by aico (${config.unsupported}); use st done`,
    )
    return 1
  }
  try {
    let committed: string | null = null
    if (paths.length) {
      const rel = repoPaths(root, deps.cwd, paths)
      const dirty = git(root, ['status', '--porcelain', '--', ...rel]).trim()
      if (dirty) {
        const message = (values.message as string | undefined) ?? `${task.title} (${taskId})`
        committed = (
          await commit(config, {
            message,
            paths: rel,
            coordination: deps.coordination,
            withAck,
            out,
            jobs: deps.jobs,
          })
        ).sha
      }
    }
    let receipt: string
    if (recordOnly) {
      const sha = committed ?? git(root, ['rev-parse', 'HEAD']).trim()
      receipt = `receipt: tree ${git(root, ['rev-parse', `${sha}^{tree}`]).trim()} commit ${sha} check record-only`
    } else {
      const report = await accept(config, {
        coordination: deps.coordination,
        withAck,
        out,
        jobs: deps.jobs,
      })
      if (!report.passed) {
        io.err(
          `Task closeout blocked: acceptance failed at ${report.sha.slice(0, 12)}; fix it, commit, and rerun aico tasks done ${taskId}`,
        )
        return 1
      }
      const ran = report.results.filter((result) => result.state !== 'skip').length
      receipt = `receipt: tree ${report.tree} commit ${report.sha} check acceptance PASS (${ran} stages, ${(report.ms / 1000).toFixed(0)} s${report.reused ? ', reused' : ''})`
    }
    const code = await runTasks(['done', ...rest], deps, io)
    if (code === 0) {
      new TaskStore(deps.db).appendLog(taskId, receipt)
      io.out(receipt)
    }
    return code
  } catch (error) {
    io.err(`Task closeout blocked: ${(error as Error).message}`)
    return 1
  }
}
