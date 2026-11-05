// A nightly pass over registered repos. Only checked main commits leave this machine;
// each repo writes Status directly, with no owner ask and no GitHub Actions wait.
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { parseArgs } from 'node:util'
import { machineId, type StatusRow } from '@aico/status'
import {
  openTasksDb,
  type Project,
  type PublicationPolicy,
  Registry,
  tasksDbPathFromEnv,
} from '@aico/tasks'
import policy from '../data/publish.json' with { type: 'json' }
import { git, gitOk, repoRoot } from './git'
import { type LocalCheck, localCheck } from './local-check'
import { webUrl } from './status'

export type PublishProject = Pick<Project, 'id' | 'root_path' | 'agent_configs'>
export interface Delivery {
  publication_complete: boolean
  pushed?: boolean
  reason: string
}
export interface Publication extends Delivery {
  project: string
  sha: string | null
  failed: string[]
  state: 'ok' | 'failed' | 'skip'
}
export interface PublishOptions {
  dryRun?: boolean
  /** An explicit publish-now request, as opposed to the scheduled pass. */
  manual?: boolean
  sha?: string
  authorizedWorkflows?: string[]
  excludedProjects?: readonly string[]
  deliver?: (root: string, sha: string, authorized: string[]) => Promise<Delivery>
  post?: (row: StatusRow) => Promise<void>
}

export function publishDecision(sha: string, check: LocalCheck | null): string | null {
  if (!check || check.sha !== sha) return 'unchecked_commit'
  if (!check.passed || check.failed.length) return 'local_check_failed'
  return null
}

export function publicationRow(result: Publication, now = new Date()): StatusRow {
  const source = result.sha ? ` at ${result.sha.slice(0, 10)}` : ''
  const problem =
    result.reason === 'unchecked_commit'
      ? `Main has no local check${source}. Owning agent: run st check --acceptance.`
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
        : `${result.pushed ? 'Published main' : 'Main is on GitHub'}${source}.`
    ).slice(0, 300),
    last_run: now.toISOString(),
    actions: [{ kind: 'run', ref: `aico publish --source ${result.project}` }],
  }
}

/** Captured diagnostics never escape: Git/transport errors may contain credentials. */
export function deliver(root: string, sha: string, authorized: string[]): Promise<Delivery> {
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
        })
      } catch {
        done({ publication_complete: false, reason: 'transport_result_unavailable' })
      }
    })
  })
}

export async function publishRepos(
  projects: readonly PublishProject[],
  options: PublishOptions = {},
): Promise<Publication[]> {
  const rows: Publication[] = []
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
          if (!gitOk(root, ['rev-parse', '--verify', '--quiet', 'refs/heads/main']))
            result.reason = 'main_unavailable'
          else {
            const sha = git(root, ['rev-parse', 'refs/heads/main']).trim()
            const held = hold?.through && hold.through !== sha
            result = { ...result, sha, state: held ? 'skip' : 'failed' }
            const check = localCheck(root, sha)
            result.failed = check?.failed ?? []
            result.reason = held
              ? 'owner_hold'
              : options.sha && git(root, ['rev-parse', `${options.sha}^{commit}`]).trim() !== sha
                ? 'source_is_not_main'
                : (publishDecision(sha, check) ?? 'checked_main')
            if (result.reason === 'checked_main') {
              if (options.dryRun) result.state = 'ok'
              else {
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
    if (!options.dryRun) await options.post?.(publicationRow(result))
  }
  return rows
}

export async function postPublicationRow(row: StatusRow, env = process.env): Promise<void> {
  const base = webUrl(env)
  if (!base) throw new Error('Publication Status address is unavailable')
  const response = await fetch(new URL('/api/status/rows', base), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify([row]),
    signal: AbortSignal.timeout(10_000),
  })
  if (!response.ok) throw new Error(`Publication Status answered ${response.status}`)
}

export const PUBLISH_USAGE = `aico publish [--source ID] [--sha REV] [--dry-run] [--json]
  Publish this project's checked main to GitHub. --all runs the nightly pass over registered
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
    authorizedWorkflows: values['authorize-workflow'],
    post: (row) => postPublicationRow(row, env),
  })
  if (values.json) console.log(JSON.stringify({ status: 'completed', projects: results }))
  else {
    for (const result of results)
      console.log(
        `${result.project}: ${result.reason}${result.sha ? ` (${result.sha.slice(0, 12)})` : ''}`,
      )
    console.log(
      `Publication: ${results.filter((r) => r.pushed).length} pushed; ${results.filter((r) => r.state === 'failed').length} failed.`,
    )
  }
  return results.some((r) => r.state === 'failed') ? 1 : 0
}
