// The Projects page's data and words. The shapes follow docs/plans/projects-page/plan.md
// (GET /api/projects/overview, /:id, /:id/timeline; POST /:id/places/:index/power).

import { apiFetch } from './api-fetch'

export type RunState = 'running' | 'stopped' | 'down' | 'starting' | 'unknown'
export type ProblemKind = 'fail' | 'quiet' | 'publish' | 'backup'
export type PowerAction = 'start' | 'shutdown' | 'restart'

export interface Problem {
  kind: ProblemKind
  count: number
}

export interface ProjectSummary {
  id: string
  name: string
  archived: boolean
  top: string | null
  waiting: { askId: string; title: string } | null
  runState: RunState | null
  problems: Problem[]
  agents: number
  lastActivity: string
}

export interface RoadmapItem {
  text: string
  plan?: string
  /** The reason, or true when no reason was written. */
  blocked?: string | boolean
  session?: string
}

export interface Place {
  kind: 'host' | 'vm' | 'ct'
  id?: number
  node?: string
  label: string
  power: boolean
  state: RunState
  since?: string | null
  asOf?: string | null
}

export interface ProblemRows {
  kind: ProblemKind
  count: number
  rows: { name: string; detail: string }[]
}

export interface ProjectAgent {
  sessionId: string
  title: string
  blocked: boolean
}

export interface ProjectDetail {
  id: string
  name: string
  overview: string
  now: RoadmapItem[]
  next: RoadmapItem[]
  later: RoadmapItem[]
  places: Place[]
  problems: ProblemRows[]
  agents: ProjectAgent[]
}

export interface Commit {
  sha: string
  subject: string
  at: string
  release?: string
}

export interface TimelinePage {
  days: { date: string; commits: Commit[] }[]
  end: boolean
}

export const fetchOverview = () =>
  apiFetch<ProjectSummary[]>(
    '/api/projects/overview',
    undefined,
    'Couldn’t load projects',
  )

export const fetchProject = (id: string) =>
  apiFetch<ProjectDetail>(
    `/api/projects/${encodeURIComponent(id)}`,
    undefined,
    'Couldn’t load this project',
  )

export const fetchTimeline = (id: string, before?: string, limit = 40) => {
  const query = new URLSearchParams({ limit: String(limit) })
  if (before) query.set('before', before)
  return apiFetch<TimelinePage>(
    `/api/projects/${encodeURIComponent(id)}/timeline?${query}`,
    undefined,
    'Couldn’t load earlier changes',
  )
}

export const postPower = (id: string, index: number, action: PowerAction) =>
  apiFetch<unknown>(
    `/api/projects/${encodeURIComponent(id)}/places/${index}/power`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ action }),
    },
    'The power change didn’t go through',
  )

// --- Order and search -------------------------------------------------------

const problemTotal = (project: ProjectSummary) =>
  project.problems.reduce((sum, problem) => sum + problem.count, 0)

const time = (iso: string) => {
  const ms = Date.parse(iso)
  return Number.isNaN(ms) ? 0 : ms
}

/** Waiting on the owner first, then problems, then recent activity. The server sorts the same way; this keeps the page right when it doesn't. */
export function orderProjects(projects: ProjectSummary[]): ProjectSummary[] {
  const rank = (p: ProjectSummary) =>
    p.waiting ? 0 : problemTotal(p) > 0 ? 1 : 2
  return [...projects].sort(
    (a, b) =>
      rank(a) - rank(b) ||
      time(b.lastActivity) - time(a.lastActivity) ||
      a.name.localeCompare(b.name),
  )
}

export function splitProjects(projects: ProjectSummary[], search: string) {
  const needle = search.trim().toLowerCase()
  const shown = needle
    ? projects.filter((p) =>
        `${p.name} ${p.id} ${p.top ?? ''}`.toLowerCase().includes(needle),
      )
    : projects
  const ordered = orderProjects(shown)
  return {
    active: ordered.filter((p) => !p.archived),
    archived: ordered.filter((p) => p.archived),
  }
}

// --- Words ------------------------------------------------------------------

const plural = (n: number, one: string, many: string) =>
  `${n} ${n === 1 ? one : many}`

/** The badge's tooltip and label. */
export function problemText(kind: ProblemKind, count: number): string {
  switch (kind) {
    case 'fail':
      return `${plural(count, 'job', 'jobs')} failed`
    case 'quiet':
      return `${plural(count, 'check', 'checks')} quiet`
    case 'publish':
      return count === 1
        ? 'Publish to GitHub failed'
        : `${count} GitHub publishes failed`
    case 'backup':
      return `${plural(count, 'backup', 'backups')} failed`
  }
}

export const agentsText = (count: number) =>
  `${plural(count, 'agent', 'agents')} working`

export const runStateText: Record<RunState, string> = {
  running: 'Running',
  stopped: 'Stopped',
  down: 'Down',
  starting: 'Starting',
  unknown: 'Can’t tell',
}

/** "9 min", "3 h", "2 d": the list's short age. */
export function shortAge(iso: string, now: number): string {
  const ms = Date.parse(iso)
  if (Number.isNaN(ms)) return ''
  const minutes = Math.max(0, Math.floor((now - ms) / 60_000))
  if (minutes < 1) return 'now'
  if (minutes < 60) return `${minutes} min`
  if (minutes < 48 * 60) return `${Math.floor(minutes / 60)} h`
  return `${Math.floor(minutes / 1440)} d`
}

/** "checked 1 min ago". */
function longAge(iso: string, now: number): string {
  const short = shortAge(iso, now)
  return short === 'now' ? 'just now' : `${short} ago`
}

const clock = (ms: number) =>
  new Date(ms).toLocaleTimeString('en-GB', {
    hour: '2-digit',
    minute: '2-digit',
  })
const dayKey = (ms: number) => new Date(ms).toDateString()
const weekday = (ms: number) =>
  new Date(ms).toLocaleDateString('en-US', { weekday: 'short' })
const monthDay = (ms: number) =>
  new Date(ms).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })

/** "Today · Nov 6", "Yesterday · Nov 5", "Wed · Nov 4", "Fri · Dec 12, 2025". */
export function dayLabel(date: string, now: number): string {
  const ms = Date.parse(date.length === 10 ? `${date}T12:00:00` : date)
  if (Number.isNaN(ms)) return date
  const md = monthDay(ms)
  if (dayKey(ms) === dayKey(now)) return `Today · ${md}`
  if (dayKey(ms) === dayKey(now - 86_400_000)) return `Yesterday · ${md}`
  const year =
    new Date(ms).getFullYear() === new Date(now).getFullYear()
      ? ''
      : `, ${new Date(ms).getFullYear()}`
  return `${weekday(ms)} · ${md}${year}`
}

/** What a place is called: "VM 180", "CT 150"; a host by its label ("Workstation"). */
export function placeName(place: Place): string {
  if ((place.kind === 'vm' || place.kind === 'ct') && place.id !== undefined)
    return `${place.kind.toUpperCase()} ${place.id}`
  return place.label
}

/** The line beside a place: "since Tue · checked 1 min ago", "stopped at 10:40". */
export function placeLine(place: Place, now: number): string {
  const since = place.since ? Date.parse(place.since) : Number.NaN
  const hasSince = !Number.isNaN(since)
  const asOf = place.asOf ? Date.parse(place.asOf) : Number.NaN
  const sinceDay = (ms: number) =>
    dayKey(ms) === dayKey(now) ? clock(ms) : weekday(ms)
  switch (place.state) {
    case 'running': {
      const parts = [
        hasSince ? `since ${sinceDay(since)}` : '',
        place.asOf ? `checked ${longAge(place.asOf, now)}` : '',
      ]
      return parts.filter(Boolean).join(' · ')
    }
    case 'stopped':
      return hasSince ? `stopped at ${clock(since)}` : 'stopped'
    case 'down':
      return hasSince
        ? `down for ${shortAge(place.since as string, now)}`
        : 'down'
    case 'starting':
      return hasSince
        ? `starting · ${Math.max(0, Math.round((now - since) / 1000))} s`
        : 'starting'
    case 'unknown':
      return `can’t reach the Proxmox host${Number.isNaN(asOf) ? '' : ` · as of ${clock(asOf)}`}`
  }
}

/** What the power sheet offers for a place; null when the mark is only an indicator. */
export function powerActions(place: Place): PowerAction[] | null {
  if (!place.power) return null
  if (place.state === 'running') return ['shutdown', 'restart']
  if (place.state === 'stopped' || place.state === 'down') return ['start']
  return null
}

const VERB: Record<PowerAction, string> = {
  start: 'Start',
  shutdown: 'Shut down',
  restart: 'Restart',
}
export const powerLabel = (action: PowerAction, target: string) =>
  `${VERB[action]} ${target}`

/** The sheet's one line of state. */
export function powerSummary(
  place: Place,
  agents: number,
  now: number,
): string {
  const since = place.since ? Date.parse(place.since) : Number.NaN
  const parts: string[] = []
  if (place.state === 'running') {
    parts.push(
      Number.isNaN(since) ? 'Running' : `Running since ${clock(since)}`,
    )
    parts.push(
      agents > 0
        ? `${plural(agents, 'agent is', 'agents are')} working on it`
        : 'No agent is working on it',
    )
  } else {
    const word = place.state === 'down' ? 'Down' : 'Stopped'
    parts.push(
      Number.isNaN(since)
        ? word
        : `${word} ${place.state === 'down' ? 'since' : 'at'} ${clock(since)}`,
    )
    if (place.asOf) parts.push(`checked ${longAge(place.asOf, now)}`)
  }
  return parts.join(' · ')
}

const MAX_SUBJECT = 100
/** One line of a commit subject; the full text goes in the tooltip. */
export function clip(subject: string, max = MAX_SUBJECT): string {
  const first = subject.split('\n')[0]?.trim() ?? ''
  return first.length > max ? `${first.slice(0, max - 1).trimEnd()}…` : first
}

export const blockedReason = (item: RoadmapItem): string =>
  typeof item.blocked === 'string' ? item.blocked : 'Waiting on you'
