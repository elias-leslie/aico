// The Projects page's API (docs/plans/projects-page/plan.md):
//
//   GET  /api/projects/overview                      one row per project, sorted
//   GET  /api/projects/:id                           the detail: roadmap, places, problems, agents
//   GET  /api/projects/:id/timeline?before=&limit=   git history of the project's root, paged
//   GET  /api/projects/:id/plan?path=                a plan document its roadmap links, as text
//   POST /api/projects/:id/places/:index/power       {action: start | shutdown | restart}
//
// Everything is read from the sources that own it: the registry (projects, where they run),
// ROADMAP.md in the project root, git, Status rows, Tether sessions and Aico asks.

import { execFile } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { maskSecrets } from '@aico/shared/secrets'
import { counted, type ShownRow, type StatusStore } from '@aico/status'
import { type Project, type Registry, type Roadmap, readRoadmap } from '@aico/tasks'
import type { TetherClient } from '@aico/tether-client'
import { readFile } from '@aico/tether-client/files'
import type { Ask } from './asks'
import { objectBody, type Router, requiredString } from './http'
import { translate } from './pane-files'
import { type Places, type PlaceView, POWER_ACTIONS, type PowerAction, runStateOf } from './places'
import { SHELL_MODE } from './sessions'
import { HttpError } from './tether'

const exec = promisify(execFile)

// -- Problems -----------------------------------------------------------------------------

const PROBLEM_KINDS = ['fail', 'quiet', 'publish', 'backup'] as const
export type ProblemKind = (typeof PROBLEM_KINDS)[number]
export type Worst = 'failed' | 'late' | 'unknown' | 'warn'

/** Which badge a counted problem row belongs to. */
export function problemKind(row: Pick<ShownRow, 'kind' | 'id' | 'shown'>): ProblemKind {
  if (row.kind === 'backup') return 'backup'
  if (/publish/i.test(row.id)) return 'publish'
  if (row.shown === 'unknown' || row.shown === 'late') return 'quiet'
  return 'fail'
}

export interface ProblemGroup {
  kind: ProblemKind
  count: number
  /** The worst state among its rows. */
  worst: Worst
  rows: { name: string; detail: string }[]
}

const SEVERITY: Record<Worst, number> = { failed: 3, late: 2, unknown: 1, warn: 0 }

/** The project's counted problem rows grouped by badge, worst group first. */
export function problemsOf(rows: readonly ShownRow[], project: string): ProblemGroup[] {
  const groups = new Map<ProblemKind, ProblemGroup>()
  for (const row of rows) {
    if (row.project !== project || !counted(row)) continue
    const kind = problemKind(row)
    const worst = row.shown as Worst
    const group = groups.get(kind) ?? { kind, count: 0, worst, rows: [] }
    group.count += 1
    if (SEVERITY[worst] > SEVERITY[group.worst]) group.worst = worst
    group.rows.push({ name: row.what, detail: row.meaning })
    groups.set(kind, group)
  }
  return [...groups.values()].sort(
    (a, b) =>
      SEVERITY[b.worst] - SEVERITY[a.worst] ||
      PROBLEM_KINDS.indexOf(a.kind) - PROBLEM_KINDS.indexOf(b.kind),
  )
}

// -- Sorting ------------------------------------------------------------------------------

export interface OverviewRow {
  id: string
  name: string
  archived: boolean
  top: string | null
  waiting: { askId: string; title: string } | null
  runState: PlaceView['state'] | null
  problems: { kind: ProblemKind; count: number; worst: Worst }[]
  agents: number
  lastActivity: string | null
}

const problemWeight = (row: OverviewRow) =>
  row.problems.reduce((sum, problem) => sum + problem.count, 0)
const failedFirst = (row: OverviewRow) =>
  row.problems.some((problem) => problem.worst === 'failed' || problem.worst === 'late') ? 1 : 0

/**
 * Waiting on the owner first, then projects with problems (failed or late before warnings, then
 * more rows), then the most recent activity, then by name. Archived projects follow, by name.
 */
export function sortOverview(rows: readonly OverviewRow[]): OverviewRow[] {
  const byName = (a: OverviewRow, b: OverviewRow) => a.name.localeCompare(b.name)
  const when = (row: OverviewRow) => (row.lastActivity ? Date.parse(row.lastActivity) : 0)
  const live = rows
    .filter((row) => !row.archived)
    .sort(
      (a, b) =>
        Number(b.waiting !== null) - Number(a.waiting !== null) ||
        failedFirst(b) - failedFirst(a) ||
        problemWeight(b) - problemWeight(a) ||
        when(b) - when(a) ||
        byName(a, b),
    )
  return [...live, ...rows.filter((row) => row.archived).sort(byName)]
}

// -- Git ----------------------------------------------------------------------------------

export type Git = (root: string, args: string[]) => Promise<string>

const realGit: Git = async (root, args) =>
  (await exec('git', ['-C', root, ...args], { timeout: 10_000, maxBuffer: 16 << 20 })).stdout

const SHA = /^[0-9a-f]{7,40}$/
const MAX_SUBJECT = 400

export interface Commit {
  sha: string
  subject: string
  at: string
  release?: string
}
export interface Day {
  date: string
  commits: Commit[]
}

const localDate = (ms: number) => {
  const d = new Date(ms)
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

// Git trailers (Co-Authored-By, Signed-off-by ...) are not changes. `%s` folds a message's first
// paragraph into one line, so a trailer written right under the subject (no blank line) comes
// back glued to it, and a message that is only a trailer comes back as the whole subject.
const TRAILER =
  /(?:^|\s)(?:co-authored-by|signed-off-by|reviewed-by|acked-by|tested-by|reported-by|suggested-by|helped-by|generated-by|assisted-by|change-id|cc)\s*:.*$/is

/** The subject without trailing trailer lines; empty when the message was only trailers. */
export function stripTrailers(subject: string): string {
  return subject.replace(TRAILER, '').trim()
}

/** `git log` lines (`sha US unix-seconds US subject`) as commits, newest first. */
export function parseLog(out: string): Commit[] {
  return out
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const [sha, seconds, ...subject] = line.split('\x1f')
      const text = stripTrailers(subject.join('\x1f'))
      const release = /^Release v?(\d+(?:\.\d+)+)/i.exec(text)?.[1]
      return {
        sha: sha as string,
        subject: text.length > MAX_SUBJECT ? `${text.slice(0, MAX_SUBJECT - 1)}…` : text,
        at: new Date(Number(seconds) * 1000).toISOString(),
        ...(release ? { release } : {}),
      }
    })
}

/** Commits grouped by (local) day, in the order given. */
export function groupDays(commits: readonly Commit[]): Day[] {
  const days: Day[] = []
  for (const commit of commits) {
    const date = localDate(Date.parse(commit.at))
    const last = days[days.length - 1]
    if (last?.date === date) last.commits.push(commit)
    else days.push({ date, commits: [commit] })
  }
  return days
}

export async function timeline(
  git: Git,
  root: string,
  before: string | undefined,
  limit: number,
): Promise<{ days: Day[]; end: boolean; available: boolean; next?: string }> {
  const format = '--format=%H%x1f%ct%x1f%s'
  let rev = 'HEAD'
  try {
    if (before) {
      await git(root, ['rev-parse', '--verify', '--quiet', `${before}^{commit}`])
      try {
        await git(root, ['rev-parse', '--verify', '--quiet', `${before}^`])
      } catch {
        return { days: [], end: true, available: true }
      }
      rev = `${before}^`
    }
    const out = await git(root, ['log', '-n', String(limit + 1), format, rev])
    const commits = parseLog(out)
    const page = commits.slice(0, limit)
    return {
      // A commit that was only trailers has no subject and is not shown, but still counts for
      // paging: `next` is where the following page starts even if this page shows nothing.
      days: groupDays(page.filter((commit) => commit.subject)),
      end: commits.length <= limit,
      available: true,
      ...(page.length ? { next: (page[page.length - 1] as Commit).sha } : {}),
    }
  } catch {
    if (before) throw new HttpError(422, 'before must be a commit of this project')
    // No checkout here, not a git repository, or no commits yet: history is unavailable.
    return { days: [], end: true, available: false }
  }
}

// -- The service --------------------------------------------------------------------------

export interface ProjectsDeps {
  registry: Pick<Registry, 'list' | 'get'>
  status: Pick<StatusStore, 'read'>
  tether: Pick<TetherClient, 'listSessions'>
  asks: { list(): Promise<Ask[]> }
  places: Places
  git?: Git
  activityMs: number
  now?: () => number
}

interface AgentRow {
  sessionId: string
  title: string
  blocked: boolean
}

export class ProjectsService {
  private readonly git: Git
  private readonly now: () => number
  private readonly activity = new Map<string, { at: number; value: Promise<string | null> }>()

  constructor(private readonly deps: ProjectsDeps) {
    this.git = deps.git ?? realGit
    this.now = deps.now ?? Date.now
  }

  private lastActivity(root: string | null): Promise<string | null> {
    if (!root) return Promise.resolve(null)
    const cached = this.activity.get(root)
    if (cached && this.now() - cached.at < this.deps.activityMs) return cached.value
    const value = this.git(root, ['log', '-1', '--format=%ct'])
      .then((out) => (out.trim() ? new Date(Number(out.trim()) * 1000).toISOString() : null))
      .catch(() => null)
    this.activity.set(root, { at: this.now(), value })
    return value
  }

  private async agents(): Promise<Map<string, AgentRow[]>> {
    const byProject = new Map<string, AgentRow[]>()
    let sessions: Awaited<ReturnType<TetherClient['listSessions']>> = []
    try {
      sessions = await this.deps.tether.listSessions()
    } catch {
      return byProject
    }
    for (const s of sessions) {
      if (!s.projectId || s.tool === SHELL_MODE || s.status !== 'running' || s.peer) continue
      const rows = byProject.get(s.projectId) ?? []
      rows.push({
        sessionId: s.id,
        title: s.displayTitle || s.name || s.label,
        blocked: s.state === 'blocked' || (s.asks ?? []).some((ask) => ask.blocking),
      })
      byProject.set(s.projectId, rows)
    }
    return byProject
  }

  /** Open asks per project: through the asking session's project, else the requester's name. */
  private async waiting(
    projects: readonly string[],
  ): Promise<Map<string, { askId: string; title: string }>> {
    const waiting = new Map<string, { askId: string; title: string }>()
    let asks: Ask[] = []
    let sessionProject = new Map<string, string>()
    try {
      asks = (await this.deps.asks.list()).filter((ask) => ask.state === 'open')
      if (asks.length)
        sessionProject = new Map(
          (await this.deps.tether.listSessions())
            .filter((s) => s.projectId)
            .map((s) => [s.id, s.projectId as string]),
        )
    } catch {
      // Without asks or sessions nothing is waiting that we can tie to a project.
    }
    const known = new Set(projects)
    // The blocking ones first, then oldest first: the one the owner should look at.
    asks.sort((a, b) => Number(b.blocking) - Number(a.blocking) || a.createdAt - b.createdAt)
    for (const ask of asks) {
      const id = (ask.session && sessionProject.get(ask.session)) || ask.requester
      if (id && known.has(id) && !waiting.has(id))
        waiting.set(id, { askId: ask.id, title: ask.question })
    }
    return waiting
  }

  private views(project: Project): PlaceView[] {
    return project.runtime.map((place) => this.deps.places.view(place))
  }

  async overview(): Promise<OverviewRow[]> {
    const projects = this.deps.registry.list({ all: true })
    const rows = this.deps.status.read().rows
    const [agents, waiting] = await Promise.all([
      this.agents(),
      this.waiting(projects.map((p) => p.id)),
    ])
    const result = await Promise.all(
      projects.map(async (project): Promise<OverviewRow> => {
        const roadmap = project.root_path ? readRoadmap(project.root_path) : null
        return {
          id: project.id,
          name: project.name,
          archived: project.retired_at !== null,
          top: roadmap?.now[0]?.text ?? null,
          waiting: waiting.get(project.id) ?? null,
          runState: runStateOf(this.views(project)),
          problems: problemsOf(rows, project.id).map(({ kind, count, worst }) => ({
            kind,
            count,
            worst,
          })),
          agents: agents.get(project.id)?.length ?? 0,
          lastActivity: await this.lastActivity(project.root_path),
        }
      }),
    )
    return sortOverview(result)
  }

  private project(id: string): Project {
    const project = this.deps.registry.get(id)
    if (!project) throw new HttpError(404, `No project ${id}`)
    return project
  }

  async detail(id: string) {
    const project = this.project(id)
    const roadmap = project.root_path ? readRoadmap(project.root_path) : null
    const [agents, waiting, lastActivity, roadmapEdited] = await Promise.all([
      this.agents(),
      this.waiting([id]),
      this.lastActivity(project.root_path),
      roadmapEditedAt(this.git, project.root_path, roadmap),
    ])
    return {
      id: project.id,
      name: project.name,
      archived: project.retired_at !== null,
      overview: roadmap?.overview ?? readmeIntro(project.root_path),
      now: roadmap?.now ?? [],
      next: roadmap?.next ?? [],
      later: roadmap?.later ?? [],
      roadmap: {
        found: roadmap !== null,
        editedAt: roadmapEdited,
        // Lines that do not follow the format; the items above already carry them as raw.
        problems: roadmap?.problems ?? [],
        other: roadmap?.other ?? [],
      },
      places: this.views(project),
      runState: runStateOf(this.views(project)),
      problems: problemsOf(this.deps.status.read().rows, id),
      agents: agents.get(id) ?? [],
      waiting: waiting.get(id) ?? null,
      lastActivity,
    }
  }

  async timeline(id: string, before: string | undefined, limit: number) {
    const project = this.project(id)
    if (!project.root_path) return { days: [], end: true, available: false }
    return timeline(this.git, project.root_path, before, limit)
  }

  /**
   * A plan document the project's roadmap links, as text with secrets hidden. Only the paths the
   * roadmap itself advertises, read inside the project's folder; nothing else is readable here.
   */
  async plan(id: string, path: string) {
    const project = this.project(id)
    const roadmap = project.root_path ? readRoadmap(project.root_path) : null
    const wanted = cleanPlanPath(path)
    const linked = new Set(
      roadmap
        ? [...roadmap.now, ...roadmap.next, ...roadmap.later].flatMap((item) =>
            item.plan ? [cleanPlanPath(item.plan)] : [],
          )
        : [],
    )
    if (!project.root_path || !wanted || !linked.has(wanted))
      throw new HttpError(404, 'The roadmap does not link this plan')
    try {
      const file = readFile(project.root_path, wanted)
      return {
        path: wanted,
        name: file.name,
        content: file.is_binary || file.content === null ? null : maskSecrets(file.content),
        truncated: file.truncated,
        binary: file.is_binary,
      }
    } catch (error) {
      throw translate(error)
    }
  }

  async power(id: string, index: number, action: PowerAction): Promise<PlaceView> {
    const project = this.project(id)
    if (project.retired_at !== null) throw new HttpError(409, `${project.name} is archived.`)
    const place = project.runtime[index]
    if (!place) throw new HttpError(404, `${project.name} has no place ${index}`)
    return this.deps.places.power(place, action)
  }
}

/** A roadmap plan path as written ("./docs/x.md" and "docs/x.md" are one); '' when unusable. */
function cleanPlanPath(path: string): string {
  const clean = path.trim().replace(/^(\.\/)+/, '')
  return clean.startsWith('/') || clean.includes('\0') ? '' : clean
}

async function roadmapEditedAt(
  git: Git,
  root: string | null,
  roadmap: Roadmap | null,
): Promise<string | null> {
  if (!root || !roadmap) return null
  try {
    const out = (await git(root, ['log', '-1', '--format=%ct', '--', 'ROADMAP.md'])).trim()
    return out ? new Date(Number(out) * 1000).toISOString() : null
  } catch {
    return null
  }
}

/** The first prose paragraph of README.md, for a project with no roadmap overview. */
export function readmeIntro(root: string | null): string | null {
  if (!root) return null
  const file = join(root, 'README.md')
  if (!existsSync(file)) return null
  let text: string
  try {
    text = readFileSync(file, 'utf8')
  } catch {
    return null
  }
  const paragraphs = text.split(/\n\s*\n/).map((p) => p.trim())
  const prose = paragraphs.find(
    (p) => p && !/^(#|!\[|\[!\[|<|```|\||>|[-*]\s|---)/.test(p) && /[a-z]{3}/i.test(p),
  )
  if (!prose) return null
  const flat = prose.replace(/\s+/g, ' ')
  return flat.length > 600 ? `${flat.slice(0, 599)}…` : flat
}

// -- Routes -------------------------------------------------------------------------------

const DEFAULT_TIMELINE = 40
const MAX_TIMELINE = 100

export function registerProjectRoutes(router: Router, service: ProjectsService): void {
  router.on('GET', '/api/projects/overview', () => service.overview())
  router.on('GET', '/api/projects/:id', (ctx) => service.detail(ctx.params.id))
  router.on('GET', '/api/projects/:id/timeline', (ctx) => {
    const before = ctx.query.get('before') || undefined
    if (before !== undefined && !SHA.test(before))
      throw new HttpError(422, 'before must be a commit id')
    const raw = ctx.query.get('limit')
    const limit = raw === null ? DEFAULT_TIMELINE : Number(raw)
    if (!Number.isInteger(limit) || limit < 1 || limit > MAX_TIMELINE)
      throw new HttpError(422, `limit must be 1 to ${MAX_TIMELINE}`)
    return service.timeline(ctx.params.id, before, limit)
  })
  router.on('GET', '/api/projects/:id/plan', (ctx) => {
    const path = ctx.query.get('path')
    if (!path) throw new HttpError(422, 'path is required')
    return service.plan(ctx.params.id, path)
  })
  router.on('POST', '/api/projects/:id/places/:index/power', async (ctx) => {
    const body = objectBody(await ctx.body())
    const action = requiredString(body, 'action', { max: 20 })
    if (!(POWER_ACTIONS as readonly string[]).includes(action))
      throw new HttpError(422, `action must be ${POWER_ACTIONS.join(', ')}`)
    const index = Number(ctx.params.index)
    if (!Number.isInteger(index) || index < 0) throw new HttpError(422, 'index must be a number')
    return service.power(ctx.params.id, index, action as PowerAction)
  })
}
