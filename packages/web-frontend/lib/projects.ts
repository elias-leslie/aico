// The Projects page's data and words. The shapes follow docs/plans/projects-page/plan.md
// (GET /api/projects/overview, /:id, /:id/timeline; POST /:id/places/:index/power).

import { ago, shortAgo } from '@aico/shared/time'
import { apiFetch } from './api-fetch'

export type RunState = 'running' | 'stopped' | 'down' | 'starting' | 'unknown'
export type ProblemKind = 'fail' | 'warn' | 'quiet' | 'publish' | 'backup'
/** Status's own state for the worst row in a group. */
export type ProblemWorst = 'failed' | 'late' | 'unknown' | 'warn'
export type PowerAction = 'start' | 'shutdown' | 'restart'

interface Problem {
  kind: ProblemKind
  count: number
  worst?: ProblemWorst
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
  lastActivity: string | null
}

export interface RoadmapItem {
  text: string
  plan?: string
  /** The reason, or true when no reason was written. */
  blocked?: string | boolean
  session?: string
  /** The line did not follow the roadmap format; `text` is the line as written. */
  raw?: true
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
  /** A power action started here that Proxmox has not finished. */
  busy?: PowerAction | null
  /** Why the state is unknown, when it is. */
  note?: string
}

export interface ProblemRows {
  kind: ProblemKind
  count: number
  worst?: ProblemWorst
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
  /** found is false when the project has no ROADMAP.md; other holds the lines of sections that are not Now, Next or Later, as written. */
  roadmap?: { found: boolean; other?: string[] }
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
  /** False when the project has no folder or it is not a git repository. */
  available?: boolean
  /** The last commit this page read, shown or not: the next page starts before it. */
  next?: string
}

/** A plan document the roadmap links, as the server hands it over (secrets already hidden). */
export interface PlanDocument {
  path: string
  name: string
  content: string | null
  truncated: boolean
  binary: boolean
}

/** The pages' days in order, one block per date: a page can end partway through a day, and the next
 * page then starts with the rest of it. */
export function joinDays(pages: readonly TimelinePage[]): TimelinePage['days'] {
  const days: TimelinePage['days'] = []
  for (const day of pages.flatMap((page) => page.days)) {
    const last = days.at(-1)
    if (last?.date === day.date)
      last.commits = [...last.commits, ...day.commits]
    else days.push({ ...day })
  }
  return days
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

export const fetchPlan = (id: string, path: string) =>
  apiFetch<PlanDocument>(
    `/api/projects/${encodeURIComponent(id)}/plan?${new URLSearchParams({ path })}`,
    undefined,
    'Couldn’t open this plan',
  )

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

const time = (iso: string | null) => {
  const ms = iso ? Date.parse(iso) : Number.NaN
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

/** The one short word beside a problem badge's count; the full sentence stays in its tooltip. */
export const PROBLEM_WORD: Record<ProblemKind, string> = {
  fail: 'failed',
  warn: 'warn',
  quiet: 'quiet',
  publish: 'publish',
  backup: 'backup',
}

/** Only Status's failed state is ember; warnings and quiet checks are amber. */
export const problemTone = (
  kind: ProblemKind,
  worst?: ProblemWorst,
): 'warn' | 'fail' =>
  kind === 'quiet' || kind === 'warn' || worst === 'warn' ? 'warn' : 'fail'

/** The badge's tooltip and label. Failed is Status's failed state only; a
 * warning is never worded as a failure (`worst` says which a backup or a
 * publish is). */
export function problemText(
  kind: ProblemKind,
  count: number,
  worst?: ProblemWorst,
): string {
  const warning = worst === 'warn'
  switch (kind) {
    case 'fail':
      return `${count} failed`
    case 'warn':
      return plural(count, 'warning', 'warnings')
    case 'quiet':
      return `${plural(count, 'check', 'checks')} quiet`
    case 'publish':
      return warning
        ? plural(count, 'GitHub publish warning', 'GitHub publish warnings')
        : count === 1
          ? 'Publish to GitHub failed'
          : `${count} GitHub publishes failed`
    case 'backup':
      return warning
        ? plural(count, 'backup warning', 'backup warnings')
        : `${plural(count, 'backup', 'backups')} failed`
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
export function shortAge(iso: string | null, now: number): string {
  const ms = iso ? Date.parse(iso) : Number.NaN
  return Number.isNaN(ms) ? '' : shortAgo(ms, now)
}

/** "checked 1 min ago". */
const longAge = (iso: string, now: number) => ago(Date.parse(iso), now)

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
export function timelineDay(date: string, now: number): string {
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

const BUSY: Record<PowerAction, string> = {
  start: 'starting',
  shutdown: 'shutting down',
  restart: 'restarting',
}

/** Why a place's state is unknown: Proxmox out of reach, or the server's own reason. */
export function unknownReason(place: Place): string {
  const note = place.note?.trim()
  if (!note || /^(Proxmox did not answer|No Proxmox access)/.test(note))
    return 'can’t reach the Proxmox host'
  return note.replace(/\.$/, '')
}

/** The line beside a place: "since Tue · checked 1 min ago", "stopped at 10:40". */
export function placeLine(place: Place, now: number): string {
  if (place.busy) return BUSY[place.busy]
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
    case 'unknown': {
      const asOfText = Number.isNaN(asOf) ? '' : ` · as of ${clock(asOf)}`
      return `${unknownReason(place)}${asOfText}`
    }
  }
}

/** What the power sheet offers for a place; null when the mark is only an indicator. */
export function powerActions(place: Place): PowerAction[] | null {
  if (!place.power || place.busy) return null
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

/** The words for each roadmap lane, and what each means. */
export const LANES = [
  { key: 'now', label: 'Now', hint: 'being worked on' },
  { key: 'next', label: 'Next', hint: 'up next' },
  { key: 'later', label: 'Later', hint: 'not started' },
] as const
type Lane = (typeof LANES)[number]['key']

/** What an empty roadmap says, and what would fill it. */
export function emptyRoadmapText(found: boolean): string {
  return found
    ? 'The roadmap has nothing under Now, Next or Later yet. Add “- item” lines under those headings in ROADMAP.md.'
    : 'No roadmap yet. Add a ROADMAP.md to the project folder with Now, Next and Later headings and “- item” lines under them; they show up here.'
}

/** A power button's words: what tapping it offers for this place. */
export function powerButtonText(place: Place): { short: string; full: string } {
  const name = placeName(place)
  const actions = powerActions(place) ?? []
  if (actions.includes('start'))
    return {
      short: 'Start',
      full: `Start ${name} (it is ${runStateText[place.state].toLowerCase()})`,
    }
  return {
    short: 'Shut down',
    full: `Shut down or restart ${name} (it is ${runStateText[place.state].toLowerCase()})`,
  }
}

/** A plan's text as blocks: code fences and tables stay as written, the rest is markdown. */
export type PlanBlock = { kind: 'text' | 'code'; text: string }
export function planBlocks(source: string): PlanBlock[] {
  const blocks: PlanBlock[] = []
  let fence = false
  const add = (kind: PlanBlock['kind'], line: string) => {
    const last = blocks.at(-1)
    if (last?.kind === kind) last.text += `\n${line}`
    else blocks.push({ kind, text: line })
  }
  for (const line of source.split('\n')) {
    if (/^\s*```/.test(line)) {
      fence = !fence
      continue
    }
    if (fence) add('code', line)
    else if (/^\s*\|/.test(line)) add('code', line)
    else add('text', line)
  }
  return blocks.filter((block) => block.text.trim() !== '')
}

const MAX_SUBJECT = 100
/** One line of a commit subject; the full text goes in the tooltip. */
export function clip(subject: string, max = MAX_SUBJECT): string {
  const first = subject.split('\n')[0]?.trim() ?? ''
  return first.length > max ? `${first.slice(0, max - 1).trimEnd()}…` : first
}

export const blockedReason = (item: RoadmapItem): string =>
  typeof item.blocked === 'string' ? item.blocked : 'Waiting on you'
