// `aico pulse`: who is working where, leases, open handshakes and what Status says is wrong.
// `aico pulse --brief` is the startup brief: the Status problems an agent has not been told yet, by
// role. Sources are Aico's own stores only: Tether's sessions and coordination documents
// and status.db rows (the Status problems are the host findings).

import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { hostname } from 'node:os'
import { dirname, join } from 'node:path'
import type { ChildAgent, SessionDescriptor } from '@aico/tether-client'
import policy from '../data/pulse-brief.json' with { type: 'json' }
import type { Registry } from './projects'

export type Policy = typeof policy

/** A Status row that is a problem now, as the brief reads it. */
export interface Finding {
  id: string
  machine: string
  what: string
  meaning: string
  project: string | null
  /** `failed` is critical; late, unknown and warn are warnings. */
  shown: 'failed' | 'late' | 'unknown' | 'warn'
  /** Epoch ms the problem started, when known. */
  since: number | null
}

export interface PulseSources {
  children?(): Promise<ChildAgent[] | null>
  now: () => number
  sessions(): Promise<SessionDescriptor[] | null>
  docNames(): Promise<string[] | null>
  doc(name: string): Promise<Record<string, unknown> | null>
  findings(): Finding[] | null
  /** Whether the process an op lease names still runs (pid and its start tick); /proc by default. */
  alive?(pid: number, start: string | null): boolean
}

/** The kernel start tick of pid (/proc/<pid>/stat field 22), as aico-hook stamps op leases with it. */
function processAlive(pid: number, start: string | null): boolean {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8')
    const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ')
    return start === null || fields[19] === start
  } catch {
    return false
  }
}

export interface Lease {
  agent: string
  project: string
  kind: string
  globs: string[]
  idleMinutes: number
}

export interface Handshake {
  id: string
  from: string
  to: string
  state: string
  ageMinutes: number
}

export interface Pulse {
  children?: ChildAgent[] | null
  generatedAt: number
  /** Null when the source did not answer: unknown, never zero. */
  sessions: SessionDescriptor[] | null
  leases: Lease[] | null
  handshakes: Handshake[] | null
  findings: Finding[] | null
}

type Row = Record<string, unknown>

const text = (v: unknown): string => (typeof v === 'string' ? v : '')

function minutesSince(stamp: unknown, now: number): number {
  const t = typeof stamp === 'string' ? Date.parse(stamp) : Number.NaN
  return Number.isFinite(t) ? Math.max(0, Math.floor((now - t) / 60_000)) : 0
}

/** The ledger's own retention (native/hook/lease/ledger.go): an older row only lingers until the next save. */
const HANDSHAKE_KEPT_MINUTES = 24 * 60

/** As the ledger reads it: an ETA ack is the recipient's to finish, and reopens once its time runs out. */
function handshakeState(m: Row, now: number): string {
  const state = text(m.state)
  if (state !== 'acked' || m.intent !== 'eta' || typeof m.eta_min !== 'number') return state
  return minutesSince(m.acked_at, now) >= m.eta_min ? 'open' : 'eta'
}

export async function collect(src: PulseSources, cfg: Policy = policy): Promise<Pulse> {
  const now = src.now()
  let leases: Lease[] | null = null
  let handshakes: Handshake[] | null = null
  const names = await src.docNames()
  if (names) {
    leases = []
    for (const name of names.filter((n) => !n.startsWith('_'))) {
      const doc = await src.doc(name)
      if (!doc) {
        leases = null
        break
      }
      for (const l of (Array.isArray(doc.leases) ? doc.leases : []) as Row[]) {
        const idle = minutesSince(l.last_heartbeat, now)
        // An op lease lives as long as its process, whatever its heartbeat; the others go idle. A lease taken
        // over (`taken_over_by`) is the taker's own: its agent is the current holder.
        if (l.kind === 'op') {
          const start = typeof l.pid_start === 'string' ? l.pid_start : null
          if (typeof l.pid !== 'number' || !(src.alive ?? processAlive)(l.pid, start)) continue
        } else if (idle >= cfg.lease_idle_minutes) continue
        leases.push({
          agent: text(l.agent_id),
          project: name,
          kind: text(l.kind) || 'file',
          globs: Array.isArray(l.globs) ? l.globs.map(String) : [],
          idleMinutes: idle,
        })
      }
    }
    const coord = await src.doc('_coord')
    if (coord) {
      handshakes = ((Array.isArray(coord.messages) ? coord.messages : []) as Row[])
        .filter(
          (m) =>
            (m.state === 'open' || m.state === 'acked') &&
            minutesSince(m.created, now) <= HANDSHAKE_KEPT_MINUTES,
        )
        .map((m) => ({
          id: text(m.id),
          from: text(m.from),
          to: text(m.to),
          state: handshakeState(m, now),
          ageMinutes: minutesSince(m.created, now),
        }))
    }
  }
  return {
    children: src.children ? await src.children() : null,
    generatedAt: now,
    sessions: await src.sessions(),
    leases,
    handshakes,
    findings: src.findings(),
  }
}

// ---------------------------------------------------------------- the full view

const age = (minutes: number): string => {
  const days = Math.floor(minutes / 1440)
  const hours = Math.floor((minutes % 1440) / 60)
  return days ? `${days}d${hours}h` : hours ? `${hours}h` : `${minutes}m`
}

export function render(p: Pulse): string[] {
  const out: string[] = []
  if (p.children === null) out.push('Children: Tether did not answer; child agents are unknown.')
  for (const parent of new Set((p.children ?? []).map((c) => c.parent))) {
    const children = (p.children ?? []).filter((c) => c.parent === parent)
    out.push(
      `Children of ${parent}: ${children.filter((c) => c.state === 'live').length} live, ${children.filter((c) => c.state === 'vanished').length} vanished${children.some((c) => c.state === 'unknown') ? `, ${children.filter((c) => c.state === 'unknown').length} unknown` : ''}`,
    )
    for (const c of children.filter((c) => c.state === 'vanished'))
      out.push(`  ${c.title} (${c.id}) vanished; check its session`)
  }
  const live = p.sessions?.filter((s) => s.status === 'running') ?? null
  const projects = new Set<string>()
  for (const s of live ?? []) projects.add(s.projectId ?? '(no project)')
  for (const l of p.leases ?? []) projects.add(l.project)
  for (const project of [...projects].sort()) {
    const sessions = (live ?? []).filter((s) => (s.projectId ?? '(no project)') === project)
    const by = (state: string) => sessions.filter((s) => (s.state ?? 'unknown') === state).length
    const parts = sessions.length
      ? `${sessions.length} sessions (${by('working')} working, ${by('idle')} idle${by('blocked') ? `, ${by('blocked')} blocked` : ''})`
      : 'no live sessions'
    out.push(`${project}: ${parts}`)
    for (const l of (p.leases ?? []).filter((x) => x.project === project))
      out.push(
        `  ${l.kind === 'file' ? 'lease' : l.kind} ${l.agent} ${l.globs.join(', ')} idle:${age(l.idleMinutes)}`,
      )
  }
  if (p.sessions === null) out.push('Sessions: Tether did not answer; live sessions are unknown.')
  if (p.leases === null) out.push('Leases: Tether did not answer; leases are unknown.')
  if (p.handshakes === null)
    out.push('Handshakes: Tether did not answer; open requests are unknown.')
  else if (p.handshakes.length === 0) out.push('Handshakes: none open.')
  else {
    const count = (state: string) => p.handshakes?.filter((h) => h.state === state).length ?? 0
    const parts = [
      [count('open'), 'open'],
      [count('acked'), 'acked, waiting on their sender'],
      [count('eta'), 'with an ETA, waiting on the recipient'],
    ] as const
    const shown = parts.filter(([n]) => n > 0).map(([n, label]) => `${n} ${label}`)
    out.push(`Handshakes: ${shown.join(', ')}`)
    for (const h of p.handshakes)
      out.push(`  ${h.id} ${h.state} ${h.from}->${h.to} ${age(h.ageMinutes)}`)
  }
  if (p.findings === null) out.push('Status: unreadable; host findings are unknown.')
  else if (p.findings.length === 0) out.push('Status: no problems.')
  else {
    out.push(`Status: ${p.findings.length} problem${p.findings.length === 1 ? '' : 's'}`)
    for (const f of p.findings) out.push(`  ${f.shown} ${f.machine}: ${f.what}: ${f.meaning}`)
  }
  return out
}

// ---------------------------------------------------------------- the startup brief

export type Role = 'coordinator' | 'agent' | 'lane' | 'subagent'

interface BriefItem {
  scope: string
  key: string
  firstSeen: string
  severity: 'critical' | 'warning'
  text: string
  blocking: boolean
}

const LABEL = { critical: 'CRIT', warning: 'WARN' } as const

function openFor(since: number | null, now: number, cfg: Policy): string {
  if (since === null) return ''
  const minutes = Math.max(0, Math.floor((now - since) / 60_000))
  if (minutes < 1440) return ` (open ${age(minutes)})`
  const stuck = minutes >= cfg.stuck_after_hours * 60 ? ', stuck' : ''
  const day = new Date(since).toLocaleDateString('en-US', { month: 'short', day: '2-digit' })
  return ` (open ${age(minutes)} since ${day}${stuck})`
}

function items(findings: Finding[], projects: ReadonlySet<string>, now: number, cfg: Policy) {
  return findings.map((f): BriefItem => {
    const tail = openFor(f.since, now, cfg)
    // The first sentence of the finding, and the machine only when it is not this one: `aico pulse` has the rest.
    const flat = f.meaning.replace(/\s+/g, ' ').trim()
    const meaning = flat.split(/(?<=[.!?])\s/)[0] ?? ''
    const where = f.machine === hostname() ? '' : `${f.machine}: `
    let body = `${where}${f.what}: ${meaning}`.trim()
    const room = cfg.max_item_chars - tail.length
    if (body.length > room) body = `${body.slice(0, room - 1)}…`
    const critical = f.shown === 'failed'
    return {
      scope: f.project && projects.has(f.project) ? f.project : 'host',
      key: f.id,
      firstSeen: f.since === null ? '' : new Date(f.since).toISOString(),
      severity: critical ? 'critical' : 'warning',
      text: body + tail,
      blocking: critical,
    }
  })
}

/** (audience, item) pairs this role may see, in display order. */
function select(
  all: BriefItem[],
  role: Role,
  project: string | null,
  cfg: Policy,
): Array<[string, BriefItem]> {
  const rolePolicy = cfg.roles[role] as {
    host?: boolean
    projects?: string
    host_first?: boolean
    blocking_only?: boolean
  }
  const sorted = [...all].sort(
    (a, b) => Number(b.severity === 'critical') - Number(a.severity === 'critical'),
  )
  const host: Array<[string, BriefItem]> = rolePolicy.host
    ? sorted.filter((i) => i.scope === 'host').map((i) => [`role:${role}`, i])
    : []
  // Only an agent working in the project spends its first-entry brief; a coordinator's overview does not.
  const mine = rolePolicy.projects === 'all' ? `role:${role}` : `project:${project ?? ''}`
  const own: Array<[string, BriefItem]> =
    project && (rolePolicy.projects === 'own' || rolePolicy.projects === 'all')
      ? sorted
          .filter((i) => i.scope === project && (i.blocking || !rolePolicy.blocking_only))
          .map((i) => [mine, i])
      : []
  const other: Array<[string, BriefItem]> =
    rolePolicy.projects === 'all'
      ? sorted
          .filter((i) => i.scope !== 'host' && i.scope !== project)
          .map((i) => [`role:${role}`, i])
      : []
  return rolePolicy.host_first ? [...host, ...own, ...other] : [...own, ...host, ...other]
}

function fit<T>(chosen: T[], cfg: Policy): T[] {
  const room = cfg.max_lines - 1
  return chosen.length <= room ? chosen : chosen.slice(0, room - 1)
}

function renderBrief(chosen: Array<[string, BriefItem]>, cfg: Policy): string[] {
  if (chosen.length === 0) return []
  const shown = fit(chosen, cfg)
  const lines = ['System brief (new since this window; `aico pulse --brief` repeats it):']
  for (const [, item] of shown) {
    const t =
      item.text.length <= cfg.max_item_chars
        ? item.text
        : `${item.text.slice(0, cfg.max_item_chars - 1)}…`
    lines.push(`- ${LABEL[item.severity]} ${item.scope}: ${t}`)
  }
  if (shown.length < chosen.length)
    lines.push(`- +${chosen.length - shown.length} more: aico pulse --brief`)
  return lines
}

/** The role of a session start: the hook payload and, for a window, Tether's lineage of it. */
export function roleOf(
  payload: Record<string, unknown>,
  widget: SessionDescriptor | null | undefined,
  inWindow: boolean,
): Role {
  if (payload.agent_id || payload.hook_event_name === 'SubagentStart') return 'subagent'
  if (!inWindow) return 'agent'
  if (widget?.coordinator) return 'coordinator'
  return widget?.coordinatorId ? 'lane' : 'agent'
}

/** What an agent was told already: `audience|key|firstSeen` -> when (ISO). A small file, no lock: a lost race shows one line twice. */
export class BriefLedger {
  constructor(private readonly path: string) {}

  load(): Record<string, string> {
    try {
      return JSON.parse(readFileSync(this.path, 'utf8')) as Record<string, string>
    } catch {
      return {}
    }
  }

  save(doc: Record<string, string>): void {
    mkdirSync(dirname(this.path), { recursive: true })
    const tmp = `${this.path}.${process.pid}.tmp`
    writeFileSync(tmp, JSON.stringify(doc))
    renameSync(tmp, this.path)
  }
}

export function ledgerPath(statusDb: string): string {
  return join(dirname(statusDb), 'pulse-brief.json')
}

/** Brief lines for one agent. With a ledger the shown items are held back for the re-show window. */
export function brief(args: {
  findings: Finding[]
  role: Role
  project: string | null
  registry: Registry
  now: number
  ledger?: BriefLedger
  cfg?: Policy
}): string[] {
  const cfg = args.cfg ?? policy
  const rolePolicy = cfg.roles[args.role] as { host?: boolean; projects?: string }
  if (rolePolicy.projects === 'none' && !rolePolicy.host) return []
  const known = new Set(args.registry.list().map((p) => p.id))
  const chosen = select(items(args.findings, known, args.now, cfg), args.role, args.project, cfg)
  if (!args.ledger) return renderBrief(chosen, cfg)
  const window = cfg.reshow_hours * 3_600_000
  const doc = args.ledger.load()
  for (const [key, when] of Object.entries(doc)) {
    if (Date.parse(when) < args.now - window) delete doc[key]
  }
  const fresh = chosen.filter(([aud, i]) => !(`${aud}|${i.key}|${i.firstSeen}` in doc))
  const lines = renderBrief(fresh, cfg)
  // An item cut by the line limit stays new.
  for (const [aud, i] of fit(fresh, cfg))
    doc[`${aud}|${i.key}|${i.firstSeen}`] = new Date(args.now).toISOString()
  try {
    args.ledger.save(doc)
  } catch {
    // The brief is advice: an unwritable ledger shows it again next time.
  }
  return lines
}
