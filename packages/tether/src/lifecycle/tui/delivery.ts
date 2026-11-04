// Aico's context delivery at launch. When `aico context delivery TOOL on` names a
// session's tool, each launch builds the session's context from context.db
// (@aico/context deliver(): the rules, prompts, memories, tool-usage block and
// recent sessions, under the tool's byte budget), writes it to the session's
// delivery folder and hands it to the tool the way its adapter declares
// (`contextDelivery`): Claude Code reads a CLAUDE.md in a directory it adds,
// Codex a developer_instructions override, Pi a system-prompt file. The content
// never travels through tmux, only the paths.
//
// AICO_CONTEXT_DELIVERED=<hash> tells Agent Hub's launchers, hooks and Pi
// extension and aico-hook to stand down, but only in the process the launch
// started: launchLine also exports AICO_CONTEXT_PID, the agent's own pid, and
// every check honours the marker only when that pid is the process itself (a
// launcher, the Pi extension) or one of its few parents (a hook the agent runs).
// A session the agent starts in turn (`codex exec` from a Claude session)
// inherits the variables but not the pid, so it gets its own delivery. When the switch is off, the tool takes no delivery, or
// anything fails, the launch stays as it was and Agent Hub's delivery runs.

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
import { getSessionEntry, getWidget, listSessions, rootRequestForWidget } from '../catalog'
import { shellQuote } from './launch'
import type { TuiSpec } from './spec'

type ContextDelivery = NonNullable<TuiSpec['contextDelivery']>
type DeliveredContext = NonNullable<TuiSpec['deliveredContext']>

/** Where aico-web keeps context.db: AICO_DATA_DIR, else the folder web.db is in. */
export function aicoDataDir(env: NodeJS.ProcessEnv = process.env): string {
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
 * to hand them to the tool. No text: no files and no words, but Agent Hub
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

export interface DeliveryDeps {
  env: NodeJS.ProcessEnv
  now(): Date
  toolUsage(cwd: string | undefined): Promise<Source<string>>
}

const DEFAULT_DEPS: DeliveryDeps = {
  env: process.env,
  now: () => new Date(),
  toolUsage: (cwd) => readToolUsage(undefined, process.env, cwd),
}

/** The project's other named sessions, for the Recent Activity lines. */
function projectActivity(widgetId: string, project: string | null): Activity[] {
  if (!project) return []
  return listSessions()
    .filter((row) => row.id !== widgetId && row.projectId === project && row.name)
    .map((row) => ({ at: row.createdAt, tool: row.tool, name: row.name as string }))
}

/** The spec to launch with this launch's context delivery, when Aico delivers to
 * the tool; else the spec as it was. Writes the session's delivery folder and
 * keeps the delivery's inventory in context.db. */
export async function withContextDelivery<T extends TuiSpec | undefined>(
  spec: T,
  widgetId: string,
  deps: DeliveryDeps = DEFAULT_DEPS,
): Promise<T> {
  const how = spec?.contextDelivery
  // A Blank Slate workspace launches with nothing added; a session entry runs in
  // a container home that cannot read this host's delivery folder.
  if (!spec || !how || !spec.command.length || spec.context?.kind === 'blank-slate') return spec
  const path = contextDbPath(aicoDataDir(deps.env))
  const dir = deliveryDir(widgetId, deps.env)
  let db: Database | null = null
  try {
    const row = getWidget(widgetId)
    if (!row || getSessionEntry(widgetId) || !existsSync(path)) return spec
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
      role: rootRequestForWidget(widgetId)?.workRole ?? null,
      coordinator: row.coordinator,
      toolUsage: await deps.toolUsage(row.projectRoot ?? undefined),
      activity: projectActivity(widgetId, row.projectId),
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
    // delivery in it, after the context as Agent Hub's launcher put them.
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
      `[tether:delivery] ${widgetId}: ${error instanceof Error ? error.message : String(error)}; Agent Hub's delivery runs instead`,
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
