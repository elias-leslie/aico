// A nightly pass over registered repos. Only checked main commits leave this machine;
// each repo writes Status directly, with no owner ask and no GitHub Actions wait.
import { spawn } from 'node:child_process'
import { appendFileSync, createWriteStream, existsSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { parseArgs } from 'node:util'
import { aicoDataDir } from '@aico/shared/data-dir'
import {
  LIMITS,
  machineId,
  outboxDir,
  postOrKeep,
  type StatusRow,
  statusRowsUrl,
} from '@aico/status'
import {
  openTasksDb,
  type Project,
  type PublicationPolicy,
  Registry,
  tasksDbPathFromEnv,
} from '@aico/tasks'
import policy from '../data/publish.json' with { type: 'json' }
import { git, gitOk, repoRoot } from './git'
import { acceptedCheck, type LocalCheck, recordCarried } from './local-check'
import { webUrl } from './status'

export type PublishProject = Pick<Project, 'id' | 'root_path' | 'agent_configs'> &
  Partial<Pick<Project, 'retired_at'>>
/** Where a refused scan found something: the entry a checked false alarm needs. Never the value. */
export interface ScanFinding {
  commit: string
  file: string
  rule: string
  line: number
}
export interface Delivery {
  publication_complete: boolean
  pushed?: boolean
  reason: string
  /** The verifier's fixed reason when it refused the history. */
  security_reason?: string
  findings?: ScanFinding[]
  /** All findings; `findings` holds the first ones. */
  findings_total?: number
}
export interface Publication extends Delivery {
  project: string
  sha: string | null
  failed: string[]
  state: 'ok' | 'failed' | 'skip'
  /** The default branch this pass looked at (main, or master when that is the only one). */
  branch?: string
  /** Why the commit counts as checked when its own record is an earlier acceptance. */
  accepted_note?: string
  /** Status could not record this result; the publication outcome itself stands. */
  status_unposted?: boolean
  /** The acceptance this pass ran for the source, and where its output went. */
  acceptance_log?: string
  /** The environment problem an acceptance reported ("environment not prepared: ..."). */
  acceptance_note?: string
  /** Where a refused scan's findings were written. */
  security_log?: string
}
/** One acceptance run for a source: whether it passed and where its output is. */
export interface AcceptanceRun {
  passed: boolean
  log: string
  /** Set when the repo's environment is not prepared; the run never reached its stages. */
  notPrepared?: string
}
export interface PublishOptions {
  dryRun?: boolean
  /** An explicit publish-now request, as opposed to the scheduled pass. */
  manual?: boolean
  sha?: string
  authorizedWorkflows?: string[]
  excludedProjects?: readonly string[]
  deliver?: (root: string, sha: string, authorized: string[]) => Promise<Delivery>
  /** Runs the missing acceptance for a source with no whole-tree check at main. Unset: never runs. */
  acceptance?: (root: string, sha: string, projectId: string) => Promise<AcceptanceRun>
  /** Most acceptances one pass starts (default: the policy's maxPerRun). */
  acceptanceCap?: number
  /** Keeps a refused scan's findings where the publish log is; returns its path. */
  refusalLog?: (result: Publication) => string
  post?: (row: StatusRow) => Promise<void>
}

/**
 * Proof is a whole-tree (full or acceptance) check of the exact commit being pushed. A quick
 * check covers only one commit's changed files, so it never proves the tree, and a passing tip
 * covers every ancestor it carries: what lands on GitHub is that checked tree.
 */
export function publishDecision(
  sha: string,
  check: LocalCheck | null,
  carriedFrom?: string,
): string | null {
  if (!check || (check.sha !== sha && check.sha !== carriedFrom)) return 'unchecked_commit'
  if (!check.passed || check.failed.length) return 'local_check_failed'
  if (check.lane === 'quick') return 'unchecked_commit'
  return null
}

const REFUSED = 'outgoing_verification_failed'
const FINGERPRINTS = "the Aico repo's native/git-outgoing/publication-fingerprints.txt"
/** A long name's end says the most; the log keeps it whole. */
const FINDING_NAME_MAX = 120
/** Stands in for a control character in a scanned name. Such a name can't be listed as a fingerprint. */
const UNPRINTABLE = '\uFFFD'

const printable = (text: string) => text.replace(/\p{Cc}/gu, UNPRINTABLE)
const clipped = (name: string) =>
  name.length > FINDING_NAME_MAX ? `…${name.slice(1 - FINDING_NAME_MAX)}` : name

/** The row for a refused history: the reason, then where, as much as Status holds. Never the value. */
function refusalMeaning(result: Publication, source: string): string {
  const head = `Outgoing verification refused this${source}: ${result.security_reason ?? 'no reason given'}`
  const log = result.security_log ? ` Log: ${result.security_log}.` : ''
  const found = result.findings ?? []
  if (!found.length) return `${head}.${log} Owning agent: repair it and publish again.`
  const fingerprint = result.security_log
    ? 'its line from that log'
    : 'its commit:file:rule:line from aico publish --json'
  const tail = `${log} Owning agent: remove it, or for a checked false alarm add ${fingerprint} to ${FINGERPRINTS}.`
  const total = result.findings_total ?? found.length
  let list = ''
  let shown = 0
  for (const finding of found) {
    const next = `${shown ? ', ' : ''}${clipped(finding.file)}:${finding.line} ${clipped(finding.rule)}`
    const more = ` and ${total - shown - 1} more`
    if (
      head.length + list.length + next.length + more.length + tail.length + 20 >
      LIMITS.meaning.max
    )
      break
    list += next
    shown++
  }
  return `${head} ${total} finding${total === 1 ? '' : 's'}: ${list}${total > shown ? ` and ${total - shown} more` : ''}.${tail}`
}

export function publicationRow(result: Publication, now = new Date()): StatusRow {
  const source = result.sha ? ` at ${result.sha.slice(0, 10)}` : ''
  const problem =
    result.reason === REFUSED
      ? refusalMeaning(result, source)
      : result.reason === 'unchecked_commit'
        ? `${result.branch ? `The ${result.branch} branch` : 'The default branch'} has no full or acceptance check${source}. Owning agent: run st check --acceptance.`
        : result.reason === 'acceptance_failed'
          ? `Acceptance failed${source}: ${result.failed.join(', ') || 'a stage'}. Log: ${result.acceptance_log}. Owning agent: fix it.`
          : result.reason === 'acceptance_incomplete'
            ? `Acceptance did not finish${source}. Log: ${result.acceptance_log}. Owning agent: run st check --acceptance.`
            : result.reason === 'environment_not_prepared'
              ? `Acceptance could not start${source}: ${result.acceptance_note ?? 'environment not prepared'}. Log: ${result.acceptance_log}.`
              : result.reason === 'local_check_failed'
                ? `Local check failed${source}: ${result.failed.join(', ') || 'check'}. Owning agent: fix it and check again.`
                : `Publication failed${source}: ${result.reason.replaceAll('_', ' ')}. Owning agent: inspect the publish log.`
  return {
    id: `publish:${result.project}`,
    what: `${result.project} GitHub publication`,
    kind: 'job',
    machine: machineId(),
    project: result.project,
    state: result.state === 'failed' ? 'failed' : 'ok',
    meaning: (result.state === 'failed'
      ? problem
      : result.state === 'skip'
        ? `Publication skipped: ${result.reason.replaceAll('_', ' ')}.`
        : `${result.pushed ? `Published ${result.branch ?? 'main'}` : `${result.branch ? `The ${result.branch} branch` : 'Main'} is on GitHub`}${source}${result.accepted_note ? ` (${result.accepted_note})` : ''}.`
    ).slice(0, result.reason === REFUSED ? LIMITS.meaning.max : 300),
    last_run: now.toISOString(),
    actions: [{ kind: 'run', ref: `aico publish --source ${result.project}` }],
  }
}

/** Only the verifier's fixed reason and the fields of a finding's location leave the transport. */
export function scanRefusal(security: unknown): Partial<Delivery> {
  if (typeof security !== 'object' || security === null) return {}
  const { reason, findings, findings_total: total } = security as Record<string, unknown>
  const found = (Array.isArray(findings) ? findings : [])
    .filter(
      (finding) =>
        typeof finding === 'object' &&
        finding !== null &&
        /^[0-9a-f]{40,64}$/.test(finding.commit) &&
        typeof finding.file === 'string' &&
        typeof finding.rule === 'string' &&
        Number.isInteger(finding.line),
    )
    .map(
      ({ commit, file, rule, line }): ScanFinding => ({
        commit,
        file: printable(file),
        rule: printable(rule),
        line,
      }),
    )
  return {
    ...(typeof reason === 'string' ? { security_reason: reason.replace(/\.$/, '') } : {}),
    ...(found.length
      ? { findings: found, findings_total: typeof total === 'number' ? total : found.length }
      : {}),
  }
}

/** Captured diagnostics never escape: Git/transport errors may contain credentials. */
function deliver(root: string, sha: string, authorized: string[]): Promise<Delivery> {
  return new Promise((done) => {
    const child = spawn(
      policy.transport[0],
      [
        ...policy.transport.slice(1),
        '--root',
        root,
        '--sha',
        sha,
        ...authorized.flatMap((path) => ['--authorize-workflow', path]),
      ],
      { stdio: ['ignore', 'pipe', 'pipe'] },
    )
    let output = ''
    child.stdout.on('data', (chunk: Buffer) => {
      output = (output + chunk.toString('utf8')).slice(-64_000)
    })
    child.stderr.resume()
    child.on('error', () => done({ publication_complete: false, reason: 'transport_unavailable' }))
    child.on('close', () => {
      try {
        const value: unknown = JSON.parse(output)
        if (typeof value !== 'object' || value === null) throw new Error('invalid result')
        const row = value as Record<string, unknown>
        if (typeof row.reason !== 'string' || !/^[a-z_]+$/.test(row.reason))
          throw new Error('invalid reason')
        done({
          publication_complete: row.publication_complete === true,
          pushed: row.pushed === true,
          reason: row.reason,
          ...scanRefusal(row.security),
        })
      } catch {
        done({ publication_complete: false, reason: 'transport_result_unavailable' })
      }
    })
  })
}

/** The repo's one default branch: main, or master when that is the only one of the two. */
function defaultBranch(root: string): 'main' | 'master' | null {
  const found = (['main', 'master'] as const).filter((name) =>
    gitOk(root, ['rev-parse', '--verify', '--quiet', `refs/heads/${name}`]),
  )
  return found.length === 1 ? found[0] : null
}

export async function publishRepos(
  projects: readonly PublishProject[],
  options: PublishOptions = {},
): Promise<Publication[]> {
  const rows: Publication[] = []
  let started = 0
  for (const project of projects) {
    let result: Publication = {
      project: project.id,
      sha: null,
      state: 'skip',
      publication_complete: false,
      reason: 'excluded_project',
      failed: [],
    }
    const excluded = options.excludedProjects ?? policy.excludedProjects
    // Evaluate exclusion and manual policy before touching the repo.
    if (!excluded.includes(project.id)) {
      const config = project.agent_configs
      const hold = config.publication_hold as PublicationPolicy['hold']
      if (config.publication_mode === 'manual' && !options.manual) result.reason = 'manual_mode'
      else if (hold && !hold.through) result.reason = 'owner_hold'
      else if (!project.root_path || !existsSync(project.root_path))
        result.reason = 'checkout_unavailable'
      else {
        const root = project.root_path
        try {
          const branch = defaultBranch(root)
          if (!branch) result.reason = 'no_default_branch'
          // Before any check: nothing could leave, so a gate has no reason to run for this. Any
          // github.com route goes on; the transport judges which it may use.
          else if (!/github\.com/i.test(git(root, ['remote', '-v'])))
            result.reason = 'no_github_remote'
          else {
            const main = git(root, ['rev-parse', `refs/heads/${branch}`]).trim()
            // A hold through REV still publishes REV once main contains it.
            const through = hold?.through
            const reachable =
              !through ||
              through === main ||
              gitOk(root, ['merge-base', '--is-ancestor', through, main])
            const sha = through && reachable ? through : main
            const held = !reachable
            result = { ...result, sha, branch, state: held ? 'skip' : 'failed' }
            let accepted = held ? null : acceptedCheck(root, sha)
            const noteAccepted = () => {
              result.failed = accepted?.check.failed ?? []
              if (accepted?.carriedFrom)
                result.accepted_note = `accepted at ${accepted.carriedFrom.slice(0, 10)}; later commits change docs only`
            }
            noteAccepted()
            result.reason = held
              ? 'owner_hold'
              : options.sha && git(root, ['rev-parse', `${options.sha}^{commit}`]).trim() !== sha
                ? through
                  ? 'source_is_not_hold'
                  : 'source_is_not_main'
                : (publishDecision(sha, accepted?.check ?? null, accepted?.carriedFrom) ??
                  'checked_main')
            // The missing step belongs to publication: run the acceptance, then decide again.
            if (
              result.reason === 'unchecked_commit' &&
              options.acceptance &&
              !options.dryRun &&
              project.retired_at == null
            ) {
              if (started >= (options.acceptanceCap ?? policy.acceptance.maxPerRun)) {
                result.state = 'skip'
                result.reason = 'acceptance_deferred'
              } else {
                started++
                const run = await options.acceptance(root, sha, project.id)
                result.acceptance_log = run.log
                accepted = acceptedCheck(root, sha)
                noteAccepted()
                result.reason = run.notPrepared
                  ? 'environment_not_prepared'
                  : (publishDecision(sha, accepted?.check ?? null, accepted?.carriedFrom) ??
                    'checked_main')
                if (run.notPrepared) result.acceptance_note = run.notPrepared
                else if (result.reason === 'unchecked_commit')
                  result.reason = 'acceptance_incomplete'
                else if (result.reason === 'local_check_failed') result.reason = 'acceptance_failed'
              }
            }
            if (result.reason === 'checked_main') {
              if (options.dryRun) result.state = 'ok'
              else {
                if (accepted) recordCarried(root, sha, accepted)
                const delivery = await (options.deliver ?? deliver)(
                  root,
                  sha,
                  options.authorizedWorkflows ?? [],
                )
                result = {
                  ...result,
                  ...delivery,
                  state: delivery.publication_complete ? 'ok' : 'failed',
                }
                if (delivery.reason === REFUSED && options.refusalLog)
                  try {
                    result.security_log = options.refusalLog(result)
                  } catch {
                    // Status and the command's output still carry the reason and where.
                  }
                if (
                  ['no_existing_upstream', 'unsafe_remote_route', 'no_github_remote'].includes(
                    delivery.reason,
                  )
                )
                  result.state = 'skip'
              }
            }
          }
        } catch {
          result = { ...result, state: 'failed', reason: 'publication_unavailable' }
        }
      }
    }
    rows.push(result)
    // One unreachable Status post never stops the other repos' publication.
    if (!options.dryRun)
      try {
        await options.post?.(publicationRow(result))
      } catch {
        result.status_unposted = true
      }
  }
  return rows
}

/**
 * Runs the policy's acceptance command (managed admission, so one heavy job at a time) for one
 * source in its own checkout. Output goes to a log per source; a repo whose environment is not
 * prepared is reported as that, not as a failed stage.
 */
function acceptanceRunner(logDir: string): NonNullable<PublishOptions['acceptance']> {
  return (root, sha, projectId) =>
    new Promise((done) => {
      mkdirSync(logDir, { recursive: true })
      const log = join(logDir, `${projectId}.log`)
      const file = createWriteStream(log)
      const [command, ...args] = policy.acceptance.command
      const child = spawn(command, [...args, '--sha', sha], {
        cwd: root,
        stdio: ['ignore', 'pipe', 'pipe'],
      })
      let tail = ''
      const take = (chunk: Buffer) => {
        file.write(chunk)
        tail = (tail + chunk.toString('utf8')).slice(-16_000)
      }
      child.stdout.on('data', take)
      child.stderr.on('data', take)
      const finish = (passed: boolean) => {
        const notPrepared = tail.match(/environment not prepared:[^\n]*/)?.[0]
        file.end(() => done({ passed, log, notPrepared }))
      }
      child.on('error', (error) => {
        file.write(`${error.message}\n`)
        finish(false)
      })
      child.on('close', (code) => finish(code === 0))
    })
}

const publishLogDir = (env: NodeJS.ProcessEnv) => join(aicoDataDir(env), 'publish-logs')

/** Adds a refusal to the project's publish log, after any acceptance this pass ran. */
export function refusalLogger(logDir: string): NonNullable<PublishOptions['refusalLog']> {
  return (result) => {
    mkdirSync(logDir, { recursive: true })
    const log = join(logDir, `${result.project}.log`)
    const found = result.findings ?? []
    const lines = [
      `${new Date().toISOString()} outgoing verification refused ${result.sha}: ${result.security_reason ?? 'no reason given'}`,
      ...(found.length
        ? [
            `${result.findings_total ?? found.length} finding(s), first ${found.length} below as commit:file:rule:line. Never the value.`,
            `Remove it, or for a checked false alarm add its line, with a comment saying why, to ${FINGERPRINTS}.`,
            ...found.map((f) =>
              `${f.commit}:${f.file}:${f.rule}:${f.line}`.includes(UNPRINTABLE)
                ? `# ${f.commit}:${f.file}:${f.rule}:${f.line} (control characters in the name: a fingerprint can't match, rename it)`
                : `${f.commit}:${f.file}:${f.rule}:${f.line}`,
            ),
          ]
        : []),
    ]
    appendFileSync(log, `${lines.join('\n')}\n`)
    return log
  }
}

async function postPublicationRow(row: StatusRow, env = process.env): Promise<void> {
  const base = webUrl(env)
  if (!base) throw new Error('Publication Status address is unavailable')
  // aico-web restarting keeps the row waiting instead of dropping it.
  await postOrKeep(statusRowsUrl(base), [row], {
    dir: outboxDir(aicoDataDir(env)),
  })
}

const PUBLISH_USAGE = `aico publish [--source ID] [--sha REV] [--dry-run] [--no-accept] [--json]
  Publish this project's checked main to GitHub. A main with no full or acceptance check gets its
  acceptance run first (--no-accept skips that and reports it unchecked). --all runs the nightly pass over registered
  projects. Failed and unchecked commits write Status for the owning agent; no owner ask.
  --authorize-workflow PATH grants an explicitly requested workflow effect; repeat as needed.`

export async function publicationPolicyCli(argv: string[], env = process.env): Promise<number> {
  const { values } = parseArgs({
    args: argv,
    options: {
      source: { type: 'string' },
      mode: { type: 'string' },
      hold: { type: 'boolean' },
      release: { type: 'boolean' },
      through: { type: 'string' },
      reason: { type: 'string' },
      reobserve: { type: 'boolean' },
      json: { type: 'boolean' },
    },
  })
  if ((values.hold && values.release) || (values.through && !values.hold))
    throw new Error('Use --hold [--through REV] or --release')
  if (values.mode && !['nightly', 'manual'].includes(values.mode))
    throw new Error('Publication mode must be nightly or manual')
  const db = openTasksDb(tasksDbPathFromEnv(env))
  try {
    const registry = new Registry(db)
    const id = values.source ?? registry.forCwd(process.cwd())?.id
    const project = id ? registry.get(id) : null
    if (!project || project.retired_at !== null)
      throw new Error('Select an open project with --source')
    const update: Partial<PublicationPolicy> = {}
    if (values.mode) update.mode = values.mode as PublicationPolicy['mode']
    if (values.hold) {
      if (!project.root_path || policy.excludedProjects.includes(project.id))
        throw new Error('This project is excluded from publication')
      const through = values.through
        ? git(project.root_path, ['rev-parse', `${values.through}^{commit}`]).trim()
        : null
      update.hold = {
        through,
        reason: (values.reason ?? 'owner hold').slice(0, 200),
        set_at: new Date().toISOString(),
      }
    } else if (values.release) update.hold = null
    const current = registry.publication(project.id, update)
    if (values.json) console.log(JSON.stringify({ project: project.id, ...current }))
    else
      console.log(
        `${project.id} publication: ${current.mode}; hold: ${current.hold ? current.hold.reason : 'none'}.`,
      )
    if (values.reobserve) {
      const rows = await publishRepos([registry.get(project.id) as Project], {
        dryRun: true,
        manual: true,
      })
      console.log(`Local selection: ${rows[0].reason}. The latest publish result is in Status.`)
    }
    return 0
  } finally {
    db.close()
  }
}

export async function publishCli(argv: string[], env = process.env): Promise<number> {
  if (argv[0] === 'policy') return publicationPolicyCli(argv.slice(1), env)
  const { values } = parseArgs({
    args: argv,
    options: {
      source: { type: 'string', multiple: true },
      project: { type: 'string', multiple: true },
      sha: { type: 'string' },
      all: { type: 'boolean' },
      'dry-run': { type: 'boolean' },
      json: { type: 'boolean' },
      now: { type: 'boolean' },
      'no-accept': { type: 'boolean' },
      'with-ack': { type: 'string' },
      'authorize-workflow': { type: 'string', multiple: true },
      help: { type: 'boolean', short: 'h' },
    },
  })
  if (values.help) {
    console.log(PUBLISH_USAGE)
    return 0
  }
  const db = openTasksDb(tasksDbPathFromEnv(env))
  let projects: Project[]
  try {
    projects = new Registry(db).list()
  } finally {
    db.close()
  }
  const ids = [...(values.source ?? []), ...(values.project ?? [])]
  if (ids.length) {
    if (ids.some((id) => !projects.some((p) => p.id === id)))
      throw new Error('No registered project for a requested source')
    projects = projects.filter((p) => ids.includes(p.id))
  } else if (!values.all) {
    const root = repoRoot(process.cwd())
    projects = projects.filter((p) => p.root_path === root)
  }
  if (!projects.length || (values.sha && projects.length !== 1))
    throw new Error('Select one registered project with --source, or use --all without --sha')
  const results = await publishRepos(projects, {
    manual: !values.all,
    sha: values.sha,
    dryRun: values['dry-run'],
    acceptance: values['no-accept'] ? undefined : acceptanceRunner(publishLogDir(env)),
    refusalLog: refusalLogger(publishLogDir(env)),
    authorizedWorkflows: values['authorize-workflow'],
    post: (row) => postPublicationRow(row, env),
  })
  if (values.json) console.log(JSON.stringify({ status: 'completed', projects: results }))
  else {
    for (const result of results) {
      console.log(
        `${result.project}: ${result.reason}${result.sha ? ` (${result.sha.slice(0, 12)})` : ''}${result.status_unposted ? '; Status not updated' : ''}`,
      )
      if (result.reason === REFUSED) console.log(`  ${publicationRow(result).meaning}`)
    }
    console.log(
      `Publication: ${results.filter((r) => r.pushed).length} pushed; ${results.filter((r) => r.state === 'failed').length} failed.`,
    )
  }
  return results.some((r) => r.state === 'failed') ? 1 : 0
}
