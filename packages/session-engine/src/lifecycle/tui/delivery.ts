// Aico's context delivery at launch. When `aico context delivery TOOL on` names a
// session's tool, each launch builds the session's context from context.db
// (@aico/context deliver(): the rules, prompts, memories, tool-usage block and
// recent sessions, under the tool's byte budget), writes it to the session's
// delivery folder and hands it to the tool the way its adapter declares
// (`contextDelivery`): Claude Code reads a CLAUDE.md in a directory it adds,
// Antigravity a file its session-start hook reads (aico-hook agy), Codex a
// developer_instructions override, Pi a system-prompt file. The content never
// travels through tmux, only the paths.
//
// AICO_CONTEXT_DELIVERED=<hash> tells aico-hook to stand down, but only in the
// process the launch started: launchLine also exports AICO_CONTEXT_PID, the
// agent's own pid, and every check honours the marker only when that pid is the
// process itself (the Pi extension) or one of its few parents (a hook the agent
// runs). A session the agent starts in turn (`codex exec` from a Claude session)
// inherits the variables but not the pid, so it gets its own delivery. When the
// switch is off, the tool takes no delivery, or anything fails, the launch stays
// as it was and the tool's aico-hook delivers, if it has one.

import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import {
  type Activity,
  contextDbPath,
  type Database,
  deliver,
  deliveryTools,
  openContext,
  readToolUsage,
  recordDelivery,
  type Source,
} from '@aico/context'
import { shellQuote } from './launch'
import type { TuiSpec } from './spec'

type ContextDelivery = NonNullable<TuiSpec['contextDelivery']>
type DeliveredContext = NonNullable<TuiSpec['deliveredContext']>

/** Where aico-web keeps context.db: AICO_DATA_DIR, else the folder web.db is in. */
function aicoDataDir(env: NodeJS.ProcessEnv = process.env): string {
  const state = env.XDG_STATE_HOME || join(env.HOME || homedir(), '.local', 'state')
  return resolve(
    env.AICO_DATA_DIR?.trim() || (env.AICO_WEB_DB ? dirname(env.AICO_WEB_DB) : join(state, 'aico')),
  )
}

/** A session's delivery folder: the files its last launch handed the tool. */
export function deliveryDir(widgetId: string, env: NodeJS.ProcessEnv = process.env): string {
  return join(aicoDataDir(env), 'deliveries', widgetId)
}

/** The files a delivery of `text` writes in `dir`, and what the launch adds
 * to hand them to the tool. No text: no files and no words, but aico-hook
 * still stands down (an empty delivery is a delivery). `instructions`: the
 * text holds the session's chosen instructions too. */
export function deliveryLaunch(
  how: ContextDelivery,
  dir: string,
  text: string,
  hash: string,
  instructions = false,
): { files: Record<string, string>; delivered: DeliveredContext } {
  const delivered = (words: string[], env: Record<string, string> = {}): DeliveredContext => ({
    arguments: words,
    env: { AICO_CONTEXT_DELIVERED: hash, ...env },
    instructions,
    hash,
    bytes: Buffer.byteLength(text),
  })
  if (!text) return { files: {}, delivered: delivered([]) }
  if (how.kind === 'hook') return { files: { [how.file]: text }, delivered: delivered([]) }
  const flags = how.arguments.map(shellQuote)
  if (how.kind === 'claude-md')
    return {
      files: { 'CLAUDE.md': text },
      delivered: delivered([...flags, shellQuote(dir)], how.env),
    }
  if (how.kind === 'config') {
    // A JSON string is a TOML basic string; `$(cat)` keeps its bytes as one word.
    const file = join(dir, 'config.toml')
    return {
      files: { 'config.toml': `${how.key}=${JSON.stringify(text)}` },
      delivered: delivered([...flags, `"$(cat ${shellQuote(file)})"`]),
    }
  }
  return {
    files: { 'context.md': text },
    delivered: delivered([...flags, shellQuote(join(dir, 'context.md'))]),
  }
}

function writeAtomic(path: string, body: string): void {
  const temporary = join(dirname(path), `.${process.pid}.tmp`)
  writeFileSync(temporary, body, { mode: 0o600 })
  renameSync(temporary, path)
}

/** A session as a delivery reads it (the catalog's widget row has all of it). */
export interface DeliverySession {
  id: string
  createdAt: number
  tool: string
  name: string | null
  projectId: string | null
  projectRoot: string | null
  sessionId: string
  coordinator: boolean
}

/** What a delivery reads of the session catalog, passed in by the engine (the
 * adapters sit below the catalog and never import it). */
export interface DeliveryCatalog {
  widget(id: string): DeliverySession | undefined
  /** Whether the session runs through an entry (a container home). */
  hasEntry(id: string): boolean
  workRole(id: string): string | null
  sessions(): DeliverySession[]
}

export interface DeliveryDeps {
  env: NodeJS.ProcessEnv
  now(): Date
  toolUsage(cwd: string | undefined, project: string | null): Promise<Source<string>>
  /** Whether Aico's project registry lists the project (the daemon passes it). */
  registered?(project: string): boolean
  catalog: DeliveryCatalog
}

/** The delivery's own defaults around the engine's catalog and registry. */
export function deliveryDeps(
  catalog: DeliveryCatalog,
  registered?: (project: string) => boolean,
): DeliveryDeps {
  return {
    env: process.env,
    now: () => new Date(),
    toolUsage: (cwd, project) => readToolUsage(undefined, process.env, cwd, project),
    ...(registered ? { registered } : {}),
    catalog,
  }
}

/** The project's other named sessions, for the Recent Activity lines. */
function projectActivity(
  catalog: DeliveryCatalog,
  widgetId: string,
  project: string | null,
): Activity[] {
  if (!project) return []
  return catalog
    .sessions()
    .filter((row) => row.id !== widgetId && row.projectId === project && row.name)
    .map((row) => ({ at: row.createdAt, tool: row.tool, name: row.name as string }))
}

/** The spec to launch with this launch's context delivery, when Aico delivers to
 * the tool; else the spec as it was. Writes the session's delivery folder and
 * keeps the delivery's inventory in context.db. */
/** A hook-limited tool's spec: pointed at the session's project, and with what needs the hook taken
 * off when the hook isn't there. */
function hookOrAsk<T extends TuiSpec>(
  spec: T,
  how: ContextDelivery,
  root: string | null | undefined,
  env: NodeJS.ProcessEnv,
): T {
  if (how.kind !== 'hook') return spec
  const home = env.HOME || homedir()
  let body = ''
  try {
    body = readFileSync(join(home, how.hooks), 'utf8')
  } catch {}
  const hooked = body.includes(how.marker) && existsSync(join(home, how.binary))
  return {
    ...spec,
    command: [
      ...(hooked ? spec.command : spec.command.filter((word) => !how.needsHook.includes(word))),
      ...(root ? [...how.workspace, shellQuote(root)] : []),
    ],
  }
}

export async function withContextDelivery<T extends TuiSpec | undefined>(
  given: T,
  widgetId: string,
  deps: DeliveryDeps,
): Promise<T> {
  const spec =
    given?.contextDelivery && given.command.length
      ? hookOrAsk(
          given as TuiSpec,
          given.contextDelivery,
          deps.catalog.widget(widgetId)?.projectRoot,
          deps.env,
        )
      : given
  return deliverInto(spec as T, widgetId, deps)
}

async function deliverInto<T extends TuiSpec | undefined>(
  spec: T,
  widgetId: string,
  deps: DeliveryDeps,
): Promise<T> {
  const how = spec?.contextDelivery
  // A Blank Slate workspace launches with nothing added; a session entry runs in
  // a container home that cannot read this host's delivery folder.
  if (!spec || !how || !spec.command.length || spec.context?.kind === 'blank-slate') return spec
  const path = contextDbPath(aicoDataDir(deps.env))
  const dir = deliveryDir(widgetId, deps.env)
  let db: Database | null = null
  try {
    const row = deps.catalog.widget(widgetId)
    if (!row || deps.catalog.hasEntry(widgetId) || !existsSync(path)) return spec
    db = openContext(path)
    if (!deliveryTools(db).includes(spec.slug)) {
      rmSync(dir, { recursive: true, force: true })
      return spec
    }
    const now = deps.now()
    const chosen =
      how.kind === 'config' && how.key === spec.instructions?.key && spec.chosenInstructions
        ? readFileSync(spec.chosenInstructions.file, 'utf8')
        : null
    const delivery = deliver(db, {
      tool: spec.slug,
      project: row.projectId,
      session: row.sessionId,
      role: deps.catalog.workRole(widgetId),
      coordinator: row.coordinator,
      toolUsage: await deps.toolUsage(row.projectRoot ?? undefined, row.projectId),
      activity: projectActivity(deps.catalog, widgetId, row.projectId),
      ...(deps.registered ? { registered: deps.registered } : {}),
      now,
      ...(chosen && spec.chosenInstructions
        ? {
            sources: [
              {
                id: `file:${spec.chosenInstructions.file}`,
                title: 'Session instructions',
                type: 'file' as const,
                text: chosen,
                required: true,
              },
            ],
          }
        : {}),
    })
    // Codex takes one developer_instructions: the chosen instructions join the
    // delivery in it, after the context.
    const text = delivery.text
    const { files, delivered } = deliveryLaunch(how, dir, text, delivery.hash, chosen !== null)
    rmSync(dir, { recursive: true, force: true })
    mkdirSync(dir, { recursive: true, mode: 0o700 })
    for (const [name, body] of Object.entries(files)) writeAtomic(join(dir, name), body)
    const { text: _text, ...summary } = delivery
    writeAtomic(
      join(dir, 'delivery.json'),
      `${JSON.stringify({ ...summary, at: now.toISOString() }, null, 2)}\n`,
    )
    recordDelivery(db, delivery, 'launch', now)
    for (const gap of delivery.missing)
      console.error(`[tether:delivery] ${widgetId}: no ${gap.id}: ${gap.reason}`)
    return { ...spec, deliveredContext: delivered }
  } catch (error) {
    console.error(
      `[tether:delivery] ${widgetId}: ${error instanceof Error ? error.message : String(error)}; launching without it`,
    )
    return spec
  } finally {
    db?.close()
  }
}

/** What the session's last launch delivered (its delivery.json), or null. */
export function lastDelivery(
  widgetId: string,
  env: NodeJS.ProcessEnv = process.env,
): { tool: string; hash: string; bytes: number; at: string } | null {
  try {
    return JSON.parse(readFileSync(join(deliveryDir(widgetId, env), 'delivery.json'), 'utf8'))
  } catch {
    return null
  }
}

/** The spec as its last launch delivered it, for the context check after a
 * daemon restart (the launch words are not needed, only what it delivered). */
export function withLastDelivery<T extends TuiSpec | undefined>(
  spec: T,
  widgetId: string,
  env: NodeJS.ProcessEnv = process.env,
): T {
  if (!spec?.contextDelivery) return spec
  const last = lastDelivery(widgetId, env)
  if (!last || last.tool !== spec.slug) return spec
  return {
    ...spec,
    deliveredContext: {
      arguments: [],
      env: {},
      instructions: false,
      hash: last.hash,
      bytes: last.bytes,
    },
  }
}

/** Drop an ended session's delivery folder. */
export function forgetDelivery(widgetId: string, env: NodeJS.ProcessEnv = process.env): void {
  rmSync(deliveryDir(widgetId, env), { recursive: true, force: true })
}
