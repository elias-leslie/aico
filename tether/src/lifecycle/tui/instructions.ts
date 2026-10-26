// Chosen instructions: an Agent Hub prompt revision picked when a session is
// created (`st aico create --instructions PROMPT[@REVISION]`). The caller
// resolves the revision and sends Tether an immutable snapshot; Tether keeps it
// per session beside the catalog and every launch of that session (restart,
// resume, crash recovery, tool replacement) adds it through the tool's
// declarative `instructions` adapter. A Blank Slate session gets nothing but
// these; other sessions get them on top of their usual context, which the
// Agent Hub launchers merge (`--append-system-prompt`, `developer_instructions`).

import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { TuiSpec } from './spec'

/** Under Linux's 128 KiB limit for one argv string, with room to spare. */
export const MAX_INSTRUCTIONS_BYTES = 64 * 1024

export interface InstructionsSnapshot {
  /** Agent Hub prompt slug. */
  prompt: string
  /** The prompt's name at that revision. */
  name: string
  /** Agent Hub prompt revision id. */
  revision: string
  contentHash: string | null
  createdAt: string | null
  content: string
}

/** What a session shows about its instructions; never the content. */
export type InstructionsSummary = Omit<InstructionsSnapshot, 'content'>

const SLUG = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/
const UUID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/

function singleLine(value: unknown, max: number): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= max &&
    // biome-ignore lint/suspicious/noControlCharactersInRegex: rejecting control characters
    !/[\u0000-\u001f\u007f]/.test(value)
  )
}

/** A snapshot as sent by a caller, else null. Content may hold tabs and
 * newlines only, and never `'''`, so it fits a TOML literal string (Codex). */
export function parseInstructions(value: unknown): InstructionsSnapshot | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null
  const v = value as Record<string, unknown>
  const allowed = ['prompt', 'name', 'revision', 'contentHash', 'createdAt', 'content']
  if (Object.keys(v).some((key) => !allowed.includes(key))) return null
  const { prompt, name, revision, contentHash = null, createdAt = null, content } = v
  if (
    typeof prompt !== 'string' ||
    !SLUG.test(prompt) ||
    !singleLine(name, 200) ||
    typeof revision !== 'string' ||
    !UUID.test(revision) ||
    (contentHash !== null &&
      !(typeof contentHash === 'string' && /^[0-9a-f]{1,128}$/.test(contentHash))) ||
    (createdAt !== null && !singleLine(createdAt, 64)) ||
    typeof content !== 'string' ||
    !content.trim() ||
    Buffer.byteLength(content) > MAX_INSTRUCTIONS_BYTES ||
    content.includes("'''") ||
    // biome-ignore lint/suspicious/noControlCharactersInRegex: rejecting control characters
    /[\u0000-\u0008\u000b-\u001f\u007f]/.test(content)
  )
    return null
  return {
    prompt,
    name,
    revision,
    contentHash: contentHash as string | null,
    createdAt: createdAt as string | null,
    content,
  }
}

export function instructionsDir(env: NodeJS.ProcessEnv = process.env): string {
  return join(env.HOME || homedir(), '.local', 'share', 'aico', 'instructions')
}

const summaries = new Map<string, InstructionsSummary | null>()

/** Keep a session's snapshot: `<id>.md` holds the content the launch reads,
 * `<id>.json` the revision it came from. Written once, before the first launch. */
export function saveInstructions(
  widgetId: string,
  snapshot: InstructionsSnapshot,
  env: NodeJS.ProcessEnv = process.env,
): void {
  const dir = instructionsDir(env)
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  const { content, ...summary } = snapshot
  for (const [name, body] of [
    [`${widgetId}.md`, content],
    [`${widgetId}.json`, JSON.stringify(summary)],
  ] as const) {
    const temporary = join(dir, `.${name}.${process.pid}`)
    writeFileSync(temporary, body, { mode: 0o600 })
    renameSync(temporary, join(dir, name))
  }
  summaries.set(widgetId, summary)
}

/** The revision a session was created with, or null. */
export function sessionInstructions(
  widgetId: string,
  env: NodeJS.ProcessEnv = process.env,
): InstructionsSummary | null {
  const known = summaries.get(widgetId)
  if (known !== undefined) return known
  let summary: InstructionsSummary | null = null
  try {
    const parsed = parseInstructions({
      ...JSON.parse(readFileSync(join(instructionsDir(env), `${widgetId}.json`), 'utf8')),
      content: 'x',
    })
    if (parsed) {
      const { content: _content, ...rest } = parsed
      summary = rest
    }
  } catch {
    // No snapshot: the session has no chosen instructions.
  }
  summaries.set(widgetId, summary)
  return summary
}

/** `prompt@revision` with the revision shortened, as titles show it. */
export function instructionsLabel(summary: InstructionsSummary): string {
  return `${summary.prompt}@${summary.revision.slice(0, 8)}`
}

/** The spec to launch for this session: with its chosen instructions when it
 * has some and the tool can take them. */
export function withInstructions<T extends TuiSpec | undefined>(
  spec: T,
  widgetId: string,
  env: NodeJS.ProcessEnv = process.env,
): T {
  if (!spec?.instructions || spec.command.length === 0) return spec
  const summary = sessionInstructions(widgetId, env)
  if (!summary) return spec
  return {
    ...spec,
    chosenInstructions: {
      file: join(instructionsDir(env), `${widgetId}.md`),
      label: instructionsLabel(summary),
    },
  }
}
