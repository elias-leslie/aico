// What keeps deploy requests from piling up or stalling: a repeat of a live request joins that
// job, a job a newer deploy already covers ends at once, and a failed acceptance either repairs
// itself (safe Biome/ruff fixes) or tells the session whose commit broke it.

import { readdirSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import type { DeployDeps, Job } from './deploy-model'

function jobs(deps: DeployDeps): Job[] {
  let names: string[]
  try {
    names = readdirSync(deps.jobsDir)
  } catch {
    return []
  }
  return names.flatMap((name) => {
    if (!name.endsWith('.json')) return []
    try {
      return [JSON.parse(readFileSync(join(deps.jobsDir, name), 'utf8')) as Job]
    } catch {
      return []
    }
  })
}

/** What a job was asked for, past its id and commit. */
function asked(argv: string[], without: string[]): string {
  return argv
    .filter((_, i) => !without.includes(argv[i]) && !without.includes(argv[i - 1]))
    .join(' ')
}

/** The job already queued or running for the same commit and the same request, its unit still alive. */
export function liveTwin(deps: DeployDeps, job: Pick<Job, 'project' | 'sha' | 'argv'>): Job | null {
  const shape = asked(job.argv, ['--sha', '--job'])
  for (const other of jobs(deps)) {
    if (other.project !== job.project || other.sha !== job.sha) continue
    if (other.state !== 'queued' && other.state !== 'running') continue
    if (asked(other.argv, ['--sha', '--job']) !== shape) continue
    const unit = deps.run('systemctl', ['--user', 'is-active', `aico-deploy-${other.id}.service`], {
      env: deps.env,
    })
    if (['active', 'activating', 'reloading'].includes(unit.out.trim())) return other
  }
  return null
}

/** A deploy of the same request, at this commit or past it, that succeeded since this job queued. */
export function coveredBy(deps: DeployDeps, root: string, job: Job): Job | null {
  if (job.argv.includes('--rollback')) return null
  const shape = asked(job.argv, ['--sha', '--job', '--with-ack'])
  for (const other of jobs(deps)) {
    if (other.id === job.id || other.project !== job.project || other.state !== 'succeeded')
      continue
    if ((other.finished_at ?? '') < job.queued_at) continue
    if (asked(other.argv, ['--sha', '--job', '--with-ack']) !== shape) continue
    if (deps.run('git', ['-C', root, 'merge-base', '--is-ancestor', job.sha, other.sha]).code === 0)
      return other
  }
  return null
}

const aicoBin = (deps: DeployDeps) => deps.env.AICO_BIN || 'aico'

/** Safe fixes for the stages that failed: the new HEAD when something was fixed and committed. */
export function repairAcceptance(
  output: string,
  root: string,
  ack: string[],
  deps: DeployDeps,
): string | null {
  // runSteps prints this under a failure Biome or ruff says it can fix.
  if (!output.includes('Biome and ruff can fix')) return null
  const stages = [...output.matchAll(/^CHECK:FAIL:([^|\s]+)\|/gm)].map((match) => match[1])
  if (!stages.length) return null
  const repaired = deps.run(aicoBin(deps), ['check', '--repair', stages.join(','), ...ack], {
    cwd: root,
    env: deps.env,
    tee: true,
  })
  if (repaired.code !== 0) return null
  const head = deps.run('git', ['-C', root, 'rev-parse', 'HEAD'])
  return head.code === 0 ? head.out.trim() : null
}

/** The first file each failed stage names that exists in the commit, with the line naming it. */
function failedFiles(
  lines: string[],
  root: string,
  sha: string,
  deps: DeployDeps,
): { file: string; line: string }[] {
  const found: { file: string; line: string }[] = []
  let named = false
  for (const line of lines) {
    if (line.startsWith('CHECK:FAIL:')) named = false
    if (named) continue
    const text = line.startsWith('CHECK:FAIL:') ? line.replace(/^.*?\|hint:/, '') : line.trim()
    for (const [token] of text.matchAll(/[\w@.[\]-]+(?:\/[\w@.[\]-]+)*/g)) {
      if (!/[./]/.test(token)) continue
      const type = deps.run('git', ['-C', root, 'cat-file', '-t', `${sha}:${token}`])
      if (type.code !== 0 || type.out.trim() !== 'blob') continue
      if (!found.some((item) => item.file === token)) found.push({ file: token, line: text })
      named = true
      break
    }
  }
  return found
}

function commitSession(root: string, sha: string, deps: DeployDeps): string | null {
  const dir = deps.run('git', ['-C', root, 'rev-parse', '--git-common-dir']).out.trim()
  try {
    const path = join(resolve(root, dir), 'aico-checks', 'receipts', `commit-session-${sha}.json`)
    return (JSON.parse(readFileSync(path, 'utf8')) as { session?: string }).session ?? null
  } catch {
    return null
  }
}

const OWN_SESSION = [
  'ST_SESSION_ID',
  'CLAUDE_SESSION_ID',
  'CLAUDE_CODE_SESSION_ID',
  'CODEX_SESSION_ID',
  'CODEX_THREAD_ID',
  'PI_SESSION_ID',
  'ANTIGRAVITY_CONVERSATION_ID',
]

/**
 * Names each failing file and the commit that last touched it, and sends the session behind that
 * commit the failure. Returns the sentence waiters read: who has been told.
 */
export function tellOwners(lines: string[], root: string, sha: string, deps: DeployDeps): string {
  const self = OWN_SESSION.map((name) => deps.env[name]).find(Boolean)
  const parts: string[] = []
  for (const { file, line } of failedFiles(lines, root, sha, deps).slice(0, 3)) {
    // A deploy's own repair commit (packages/checks/src/repair.ts) is nobody's change to answer for.
    const log = deps.run('git', [
      '-C',
      root,
      'log',
      '-1',
      '--format=%H%x00%s',
      '--invert-grep',
      '--grep=^Deploy: safe format',
      sha,
      '--',
      file,
    ])
    const [commit, subject] = log.out.trim().split('\0')
    if (!commit) continue
    const name = `${file}, last changed in ${commit.slice(0, 10)} (${(subject ?? '').slice(0, 60)})`
    const session = commitSession(root, commit, deps)
    if (!session) {
      parts.push(`${name}: its session isn't on record, nobody told`)
    } else if (session === self) {
      parts.push(`${name}: this session's own commit`)
    } else {
      const text = `A deploy of ${sha.slice(0, 10)} stopped on your commit ${commit.slice(0, 10)}: ${file} fails acceptance. Fix it and commit, then st service rebuild aico --detach ships it for everyone waiting. Failure: ${line.slice(0, 160)}`
      const sent = deps.run(
        aicoBin(deps),
        ['sessions', 'send', session, text, '--source-key', `deploy-fail-${commit}-${file}`],
        { cwd: root, env: deps.env },
      )
      parts.push(
        sent.code === 0
          ? `${name}: told ${session}`
          : `${name}: could not reach ${session}, nobody told`,
      )
    }
  }
  return parts.join('; ')
}
