// Context delivery: the text every new agent session starts with. Prompts and
// memories come from context.db by Agent Hub's scope rules (global, the session's
// project, its role) and their applicability, never by search; the tool-usage
// block and the recent-activity lines come from the caller. Sections render in
// authority order; a per-tool byte budget (data/delivery.json) cuts the lowest
// priority ones first and says what it cut. recordDelivery keeps the per-item
// inventory for the context cost view.

import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import config from '../data/delivery.json' with { type: 'json' }
import { budgetHint, contextSessionId, type ItemType } from './cost'
import { type Database, getSetting, json, putSetting } from './db'

export type DeliveryConfig = typeof config
export const DELIVERY: DeliveryConfig = config

/** Render order: authority first. */
export const KINDS = [
  'guardrail',
  'mandate',
  'project',
  'role',
  'instruction',
  'activity',
  'tool-usage',
] as const
export type Kind = (typeof KINDS)[number]
const NEVER_CUT: readonly Kind[] = ['guardrail', 'mandate']

export interface Activity {
  /** Epoch ms the session started. */
  at: number
  tool: string
  name: string
}

/** A computed source: its text, or why it could not be read. */
export type Source<T> = T | { error: string }

export interface DeliverRequest {
  tool: string
  project?: string | null
  session?: string | null
  /** An Aico role (roles table) or a work role id. */
  role?: string | null
  coordinator?: boolean
  /** The text goes out through a hook, so the tool's hook budget (if it has one) applies. */
  hook?: boolean
  /** The tool-usage manifest body (without the <tool-usage> wrapper); omitted: none asked for. */
  toolUsage?: Source<string>
  /** The project's other sessions; omitted: none asked for. */
  activity?: Source<Activity[]>
  /** Caller-owned files, skills or rules actually handed to the agent. */
  sources?: { id: string; title: string; type: ItemType; text: string; required?: boolean }[]
  now?: Date
}

export interface Item {
  id: string
  bytes: number
  title?: string
  type?: ItemType
  hash?: string
}

export interface Section {
  id: string
  kind: Kind
  title: string
  bytes: number
  items: Item[]
  required?: boolean
}

export interface Delivery {
  tool: string
  project: string | null
  session: string | null
  role: string | null
  hash: string
  bytes: number
  budget: number
  over: boolean
  sections: Section[]
  cut: Section[]
  missing: { id: string; reason: string }[]
  text: string
}

interface Built extends Section {
  body: string
}

type Missing = { id: string; reason: string }[]

const SEPARATOR = '\n\n'
const bytesOf = (text: string) => Buffer.byteLength(text)
const hashOf = (text: string) => createHash('sha256').update(text).digest('hex')

export class UnknownTool extends Error {}

/** The adapter id for a tool name or alias; throws UnknownTool. */
export function toolId(name: string, settings: DeliveryConfig = DELIVERY): string {
  const id = (settings.aliases as Record<string, string>)[name] ?? name
  if (!(id in settings.tools)) throw new UnknownTool(`unknown tool ${name}`)
  return id
}

// --- who the session is -------------------------------------------------------

interface Consumer {
  tool: string
  project: string | null
  role: string | null
  tags: Set<string>
  /** The role starts sessions with no added context (roles.context = blank-slate). */
  blank: boolean
}

/** json(), or the fallback when the text is not JSON. */
const safeJson = <T>(text: unknown, fallback: T): T => {
  try {
    return json(text, fallback)
  } catch {
    return fallback
  }
}

const lower = (value: unknown): string[] =>
  Array.isArray(value)
    ? value.filter((v): v is string => typeof v === 'string').map((v) => v.trim().toLowerCase())
    : []

/** Audience tags: `work-role:<id>` for the role's work roles, `aico-coordinator`
 * for a coordinator, and `work-role:unknown` when no known work role applies
 * (Agent Hub's rule, so a memory can target "coordinators and unknown roles"). */
function consumerOf(
  db: Database,
  request: DeliverRequest,
  tool: string,
  missing: Missing,
): Consumer {
  const role = request.role?.trim() || null
  const known = new Set<string>()
  for (const row of db.prepare('SELECT work_roles FROM roles').all() as { work_roles: string }[])
    for (const work of lower(safeJson(row.work_roles, []))) known.add(work)
  const tags = new Set<string>()
  const row = role
    ? (db
        .prepare(
          'SELECT r.work_roles, coalesce(o.mode, r.context) AS context FROM roles r LEFT JOIN role_context_overrides o ON o.role = r.name WHERE r.name = ?',
        )
        .get(role) as { work_roles: string; context: string | null } | undefined)
    : undefined
  if (role) {
    const works = row ? lower(safeJson(row.work_roles, [])) : [role.toLowerCase()]
    for (const work of works) if (known.has(work)) tags.add(`work-role:${work}`)
  }
  if (!tags.size) tags.add('work-role:unknown')
  if (request.coordinator) tags.add('aico-coordinator')
  // Only a project in the registry (project_permissions, imported from Agent Hub)
  // gets project scope; a folder name or a stale id gets the global context alone.
  let project = request.project?.trim() || null
  if (
    project &&
    !db.prepare('SELECT 1 FROM project_permissions WHERE project_id = ? LIMIT 1').get(project)
  ) {
    missing.push({
      id: 'project',
      reason: `${project} is not in the project registry; global context only`,
    })
    project = null
  }
  return { tool, project, role, tags, blank: row?.context === 'blank-slate' }
}

/** Agent Hub's identifier form: case, CamelCase, spaces and hyphens become snake case. */
const identifier = (name: string): string =>
  name
    .trim()
    .replace(/(?<=[a-z0-9])(?=[A-Z])/g, '_')
    .replace(/[^A-Za-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .toLowerCase()

/** A surface name as the adapter id (claude_cli, codex_tui, pi_mono ... by `surfaceAliases`). */
const surfaceOf = (name: string, settings: DeliveryConfig): string => {
  const id = identifier(name)
  return (settings.surfaceAliases as Record<string, string>)[id] ?? id.replace(/_/g, '-')
}

/** An agent slug in Agent Hub's canonical hyphen style. */
const slugOf = (name: string): string => identifier(name).replace(/_/g, '-')

/** Agent Hub's applicability check: surfaces (tools), profiles, agent slugs, audience tags. */
function applies(
  applicability: Record<string, unknown>,
  who: Consumer,
  settings: DeliveryConfig,
): boolean {
  const surfaces = (key: string) =>
    lower(applicability[key]).map((name) => surfaceOf(name, settings))
  const tools = surfaces('consumer_surfaces')
  if (tools.length && !tools.includes(who.tool)) return false
  if (surfaces('exclude_consumer_surfaces').includes(who.tool)) return false
  const profiles = lower(applicability.consumer_profiles)
  if (profiles.length && !profiles.includes(settings.profile)) return false
  if (lower(applicability.exclude_consumer_profiles).includes(settings.profile)) return false
  const slug = who.role ? slugOf(who.role) : null
  const slugs = lower(applicability.agent_slugs).map(slugOf)
  if (slugs.length && !(slug && slugs.includes(slug))) return false
  if (slug && lower(applicability.exclude_agent_slugs).map(slugOf).includes(slug)) return false
  const audience = lower(applicability.audience_tags)
  if (audience.length && !audience.some((tag) => who.tags.has(tag))) return false
  return !lower(applicability.exclude_audience_tags).some((tag) => who.tags.has(tag))
}

/** A JSON object column, or why it is not one (the caller skips that row). */
function objectColumn<T extends object>(text: unknown, fallback: T): T {
  const value = json<unknown>(text, fallback)
  if (typeof value !== 'object' || value === null || Array.isArray(value))
    throw new Error('not a JSON object')
  return value as T
}

// --- prompts ------------------------------------------------------------------

interface PromptRow {
  id: number
  slug: string
  name: string
  description: string
  content: string
  kind: string
  is_global: number
  context_policy: string | null
}

interface Policy {
  scope?: string
  targets?: string[]
  workflows?: string[]
  activation?: string
  task_types?: string[]
  phases?: string[]
  applicability?: Record<string, unknown>
  format?: string
}

function promptSections(
  db: Database,
  who: Consumer,
  settings: DeliveryConfig,
  missing: Missing,
): Built[] {
  const rows = db
    .prepare(
      'SELECT id, slug, name, description, content, kind, is_global, context_policy FROM prompts ORDER BY slug',
    )
    .all() as unknown as PromptRow[]
  const sections: Built[] = []
  const linked = new Set(
    (
      db.prepare('SELECT prompt_id FROM role_prompts WHERE role = ?').all(who.role ?? '') as {
        prompt_id: number
      }[]
    ).map((p) => p.prompt_id),
  )
  for (const row of rows) {
    let policy: Policy
    try {
      policy = objectColumn<Policy>(row.context_policy, { scope: row.is_global ? 'global' : '' })
    } catch (error) {
      missing.push({
        id: `prompt:${row.slug}`,
        reason: `its context_policy is unreadable (${(error as Error).message}); skipped`,
      })
      continue
    }
    const targets = policy.targets ?? []
    const scoped = linked.has(row.id)
      ? 'role'
      : policy.scope === 'global'
        ? 'instruction'
        : policy.scope === 'project' && who.project && targets.includes(who.project)
          ? 'project'
          : policy.scope === 'agent' && who.role && targets.includes(who.role)
            ? 'role'
            : null
    if (!scoped) continue
    // Upfront rules only: on-demand and task- or phase-triggered ones need a request we don't have.
    const activation = policy.activation ?? 'always'
    if (activation === 'on_demand') continue
    if (activation === 'triggered' && (policy.task_types?.length || policy.phases?.length)) continue
    const applicability =
      typeof policy.applicability === 'object' && policy.applicability !== null
        ? policy.applicability
        : {}
    if (!applies(applicability, who, settings)) continue
    const kind: Kind =
      row.kind === 'global_guardrail'
        ? 'guardrail'
        : row.kind === 'global_mandate'
          ? 'mandate'
          : scoped
    const content = (
      (policy.format ?? 'full') !== 'full' && row.description ? row.description : row.content
    ).trim()
    const body = `## ${row.name}\n${content}`
    sections.push({
      id: `prompt:${row.slug}`,
      kind,
      title: row.name,
      bytes: bytesOf(body),
      items: [
        {
          id: `prompt:${row.slug}`,
          title: row.name,
          type: 'prompt',
          hash: hashOf(body),
          bytes: bytesOf(body),
        },
      ],
      body,
    })
  }
  return sections
}

// --- memories -----------------------------------------------------------------

interface MemoryRow {
  id: string
  summary: string
  scope: string
  scope_id: string
  tier: 'guardrail' | 'mandate'
  content: string
  triggers: string
  applicability: string
}

const SCOPE_ORDER: Record<string, number> = { project: 0, agent: 1, global: 2 }

/** Guardrail and mandate memories for the session's scopes: project first, then
 * role, then global, newest first within each (Agent Hub's order). */
function memorySections(
  db: Database,
  who: Consumer,
  settings: DeliveryConfig,
  missing: Missing,
): Built[] {
  const rows = db
    .prepare(
      `SELECT id, summary, scope, scope_id, tier, content, triggers, applicability FROM memories
       WHERE tier IN ('guardrail', 'mandate')
         AND (scope = 'global' OR (scope = 'project' AND scope_id = ?) OR (scope = 'agent' AND scope_id = ?))
       ORDER BY created_at DESC, id`,
    )
    .all(who.project ?? '', who.role ?? '') as unknown as MemoryRow[]
  const chosen = rows
    .filter((row) => {
      try {
        const triggers = json<unknown>(row.triggers, [])
        if (!Array.isArray(triggers)) throw new Error('triggers are not a list')
        return !triggers.length && applies(objectColumn(row.applicability, {}), who, settings)
      } catch (error) {
        missing.push({
          id: `memory:${row.id}`,
          reason: `its triggers or applicability are unreadable (${(error as Error).message}); skipped`,
        })
        return false
      }
    })
    .sort((a, b) => (SCOPE_ORDER[a.scope] ?? 3) - (SCOPE_ORDER[b.scope] ?? 3))
  const sections: Built[] = []
  for (const tier of ['guardrail', 'mandate'] as const) {
    const lines = chosen
      .filter((row) => row.tier === tier)
      .map((row) => ({
        id: `memory:${row.id}`,
        title:
          row.summary || row.content.trim().split('\n')[0]?.slice(0, 100) || `memory:${row.id}`,
        line: `- [${tier === 'guardrail' ? 'G' : 'M'}:${row.id.slice(0, 8)}] ${row.content.trim()}`,
      }))
    if (!lines.length) continue
    const body = `## Runtime Memory\n${lines.map((entry) => entry.line).join('\n')}`
    sections.push({
      id: `memories:${tier}`,
      kind: tier,
      title: 'Runtime Memory',
      bytes: bytesOf(body),
      items: lines.map((entry) => ({
        id: entry.id,
        title: entry.title,
        type: 'memory',
        hash: hashOf(entry.line),
        bytes: bytesOf(entry.line) + 1,
      })),
      body,
    })
  }
  return sections
}

// --- computed blocks ----------------------------------------------------------

function ago(ms: number): string {
  const minutes = Math.max(0, Math.floor(ms / 60_000))
  if (minutes < 60) return `${minutes}m ago`
  const hours = Math.floor(minutes / 60)
  return hours < 24 ? `${hours}h ago` : `${Math.floor(hours / 24)}d ago`
}

function activitySection(activity: Activity[], now: Date, settings: DeliveryConfig): Built | null {
  const oldest = now.getTime() - settings.activity.maxAgeDays * 86_400_000
  const lines = activity
    .filter((entry) => entry.name.trim() && entry.at >= oldest)
    .sort((a, b) => b.at - a.at)
    .slice(0, settings.activity.maxLines)
    .map((entry) => `- [${ago(now.getTime() - entry.at)}] ${entry.tool}: ${entry.name.trim()}`)
  if (!lines.length) return null
  const body = `## Recent Activity\n${lines.join('\n')}`
  return {
    id: 'activity',
    kind: 'activity',
    title: 'Recent Activity',
    bytes: bytesOf(body),
    items: [{ id: 'activity', bytes: bytesOf(body) }],
    body,
  }
}

function toolUsageSection(manifest: string): Built | null {
  if (!manifest.trim()) return null
  const body = `<tool-usage>\n${manifest.trim()}\n</tool-usage>`
  return {
    id: 'tool-usage',
    kind: 'tool-usage',
    title: 'Tool Usage',
    bytes: bytesOf(body),
    items: [{ id: 'tool-usage', bytes: bytesOf(body) }],
    body,
  }
}

const failed = <T>(source: Source<T> | undefined): source is { error: string } =>
  typeof source === 'object' && source !== null && 'error' in source

// --- delivery -----------------------------------------------------------------

const total = (sections: Built[]) =>
  sections.reduce((sum, section) => sum + section.bytes, 0) +
  Math.max(0, sections.length - 1) * SEPARATOR.length

/** Cut sections in `cutOrder`, the last of a kind first, until the text fits; then
 * put cut sections back, highest priority first (the reverse of `cutOrder`, in
 * render order within a kind), while they fit: one big cut can free more room than
 * the overshoot needed, and a small section that fits is not worth losing. */
function fit(sections: Built[], budget: number, settings: DeliveryConfig) {
  const order = settings.cutOrder as Kind[]
  let kept = [...sections]
  let cut: Built[] = []
  for (const kind of order) {
    if (NEVER_CUT.includes(kind)) continue
    for (let index = kept.length - 1; index >= 0 && total(kept) > budget; index--) {
      const section = kept[index] as Built
      if (section.required) continue
      if (section.kind !== kind) continue
      kept.splice(index, 1)
      cut.push(section)
    }
  }
  const priority = (section: Built) => order.length - order.indexOf(section.kind)
  const back = [...cut].sort(
    (a, b) => priority(b) - priority(a) || sections.indexOf(a) - sections.indexOf(b),
  )
  for (const section of back) {
    const candidate = [...kept, section].sort((a, b) => sections.indexOf(a) - sections.indexOf(b))
    if (total(candidate) > budget) continue
    kept = candidate
    cut = cut.filter((entry) => entry !== section)
  }
  return { kept, cut, over: total(kept) > budget }
}

const publicSection = ({ body: _body, ...section }: Built): Section => section

function selected(
  db: Database,
  who: Consumer,
  request: DeliverRequest,
  settings: DeliveryConfig,
  missing: Missing,
): Built[] {
  const sections = who.blank
    ? []
    : [...promptSections(db, who, settings, missing), ...memorySections(db, who, settings, missing)]
  for (const source of request.sources ?? [])
    if (source.text.trim())
      sections.push({
        id: source.id,
        kind: 'instruction',
        title: source.title,
        bytes: bytesOf(source.text),
        required: source.required,
        items: [
          {
            id: source.id,
            title: source.title,
            type: source.type,
            hash: hashOf(source.text),
            bytes: bytesOf(source.text),
          },
        ],
        body: source.text,
      })
  if (who.blank) return sections.filter((s) => s.required)
  if (failed(request.activity)) missing.push({ id: 'activity', reason: request.activity.error })
  else if (request.activity && who.project) {
    const section = activitySection(request.activity, request.now ?? new Date(), settings)
    if (section) sections.push(section)
  }
  if (failed(request.toolUsage)) missing.push({ id: 'tool-usage', reason: request.toolUsage.error })
  else if (request.toolUsage !== undefined) {
    const section = toolUsageSection(request.toolUsage)
    if (section) sections.push(section)
    else missing.push({ id: 'tool-usage', reason: 'the tool-usage command printed nothing' })
  }
  return sections
}

export function deliver(
  db: Database,
  request: DeliverRequest,
  settings: DeliveryConfig = DELIVERY,
): Delivery {
  const tool = toolId(request.tool, settings)
  const missing: Missing = []
  const who = consumerOf(db, request, tool, missing)
  // Blank Slate skips shared context; explicit required caller instructions survive.
  const sections = selected(db, who, request, settings, missing)
  // Stable: within a kind, prompts keep slug order and memory groups their tier order.
  sections.sort((a, b) => KINDS.indexOf(a.kind) - KINDS.indexOf(b.kind))
  const limits = (
    settings.tools as Record<string, { budgetBytes: number; hookBudgetBytes?: number }>
  )[tool] as { budgetBytes: number; hookBudgetBytes?: number }
  // What the tool's hook carries in full (Claude Code keeps hook output over ~10k
  // characters as a file plus a preview) can be less than the launch budget.
  const budget = request.hook
    ? Math.min(limits.budgetBytes, limits.hookBudgetBytes ?? limits.budgetBytes)
    : limits.budgetBytes
  let { kept, cut, over } = fit(sections, budget, settings)
  const result = (): Delivery => ({
    tool,
    project: who.project,
    session: request.session?.trim() || null,
    role: who.role,
    hash: createHash('sha256')
      .update(kept.map((s) => s.body).join(SEPARATOR))
      .digest('hex'),
    bytes: bytesOf(kept.map((s) => s.body).join(SEPARATOR)),
    budget,
    over:
      over && kept.reduce((sum, s) => sum + s.bytes + SEPARATOR.length, -SEPARATOR.length) > budget,
    sections: kept.map(publicSection),
    cut: cut.map(publicSection),
    missing,
    text: kept.map((s) => s.body).join(SEPARATOR),
  })
  const hint = budgetHint(db, result())
  if (hint) {
    const room = budget - bytesOf(hint) - SEPARATOR.length
    ;({ kept, cut, over } = fit(sections, Math.max(0, room), settings))
    const line = budgetHint(db, result())
    if (line)
      kept.push({
        id: 'context-budget',
        kind: 'activity',
        title: 'Context budget',
        body: line,
        bytes: bytesOf(line),
        items: [{ id: 'context-budget', bytes: bytesOf(line) }],
      })
  }
  return result()
}

/** Keep what a delivery loaded into a session (and what it cut), item by item, and
 * drop inventory older than `keepDays` (data/delivery.json). */
export function recordDelivery(
  db: Database,
  delivery: Delivery,
  channel: string,
  at: Date,
  settings: DeliveryConfig = DELIVERY,
): number {
  const oldest = new Date(at.getTime() - settings.keepDays * 86_400_000).toISOString()
  db.prepare('DELETE FROM deliveries WHERE at < ?').run(oldest)
  const row = db
    .prepare(
      `INSERT INTO deliveries (at, tool, project, session, role, channel, hash, bytes, budget, over, missing)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`,
    )
    .get(
      at.toISOString(),
      delivery.tool,
      delivery.project,
      contextSessionId(delivery.session),
      delivery.role,
      channel,
      delivery.hash,
      delivery.bytes,
      delivery.budget,
      delivery.over ? 1 : 0,
      JSON.stringify(delivery.missing),
    ) as { id: number }
  const insert = db.prepare(
    'INSERT INTO delivery_items (delivery_id, position, section, kind, item, bytes, cut, title, item_type, content_hash) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
  )
  let position = 0
  for (const [sections, cut] of [
    [delivery.sections, 0],
    [delivery.cut, 1],
  ] as const)
    for (const section of sections)
      for (const item of section.items)
        insert.run(
          row.id,
          position++,
          section.id,
          section.kind,
          item.id,
          item.bytes,
          cut,
          item.title ?? section.title,
          item.type ?? null,
          item.hash ?? null,
        )
  return row.id
}

// --- the per-tool switch --------------------------------------------------------

const SWITCH = 'delivery.tools'

/** Tools Tether delivers context to at launch (the rest only get their aico-hook's). */
export function deliveryTools(db: Database): string[] {
  return getSetting<string[]>(db, SWITCH) ?? []
}

export function setDeliveryTool(db: Database, tool: string, on: boolean): string[] {
  const id = toolId(tool)
  const tools = new Set(deliveryTools(db))
  if (on) tools.add(id)
  else tools.delete(id)
  const next = [...tools].sort()
  putSetting(db, SWITCH, next)
  return next
}

// --- the tool-usage block -------------------------------------------------------

/** Run the configured tool-usage command (`st tools manifest ...`): its output, or why not. */
export function readToolUsage(
  settings: DeliveryConfig = DELIVERY,
  env: NodeJS.ProcessEnv = process.env,
  cwd?: string,
): Promise<Source<string>> {
  const [command, ...args] = settings.toolUsage.command
  return new Promise((resolve) => {
    execFile(
      command as string,
      args,
      { env, cwd, timeout: settings.toolUsage.timeoutMs, maxBuffer: 1024 * 1024 },
      (error, stdout) => {
        if (error)
          resolve({
            error: `${settings.toolUsage.command.join(' ')}: ${error.killed ? 'timed out' : error.message.split('\n')[0]}`,
          })
        else resolve(stdout)
      },
    )
  })
}
