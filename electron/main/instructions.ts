// Chosen instructions for a new session: the Agent Hub prompt revisions the
// New session picker offers, and the snapshot Tether keeps for the session
// (docs/root-control.md "Chosen instructions"). Read through `st prompt`, as
// `st aico create --instructions` does; nothing is cached, so the picker always
// shows the store as it is.

import type { ExecFileException, ExecFileOptions } from 'node:child_process'
import type { IpcMain } from 'electron'

/** Tether's limit (tether/src/lifecycle/tui/instructions.ts); Tether checks again. */
const MAX_INSTRUCTIONS_BYTES = 64 * 1024
const SLUG = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/
const UUID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/

/** A prompt the picker lists. */
export interface InstructionPrompt {
  slug: string
  name: string
  description: string
}

/** One revision of a prompt, newest first. `current` holds the prompt's
 * content now; an unusable one can't be sent (empty, too long, or text the
 * tools can't take). */
export interface InstructionRevision {
  id: string
  createdAt: string | null
  reason: string
  current: boolean
  usable: boolean
}

/** What the renderer sends with a new session. */
export interface InstructionsChoice {
  prompt: string
  revision: string
}

/** What Tether keeps for the session (`instructions` on create). */
export interface InstructionsSnapshot {
  prompt: string
  name: string
  revision: string
  contentHash: string | null
  createdAt: string | null
  content: string
}

export type Listing<T> = { status: 'ready'; items: T[] } | { status: 'unavailable'; items: [] }

interface InstructionsDeps {
  /** The `st` executable. */
  st: string
  execFile(
    file: string,
    args: string[],
    options: ExecFileOptions,
    callback: (error: ExecFileException | null, stdout: string | Buffer) => void,
  ): unknown
}

type Row = Record<string, unknown>

function text(value: unknown): string | null {
  return typeof value === 'string' ? value : null
}

export function usableContent(content: string): boolean {
  return (
    content.trim().length > 0 &&
    Buffer.byteLength(content) <= MAX_INSTRUCTIONS_BYTES &&
    !content.includes("'''") &&
    // biome-ignore lint/suspicious/noControlCharactersInRegex: rejecting control characters
    !/[\u0000-\u0008\u000b-\u001f\u007f]/.test(content)
  )
}

/** The renderer's choice, else null (untrusted input). */
export function parseChoice(value: unknown): InstructionsChoice | null {
  if (typeof value !== 'object' || value === null) return null
  const { prompt, revision } = value as Row
  return typeof prompt === 'string' &&
    SLUG.test(prompt) &&
    typeof revision === 'string' &&
    UUID.test(revision)
    ? { prompt, revision }
    : null
}

export function createInstructions(deps: InstructionsDeps) {
  function st(args: string[]): Promise<unknown> {
    return new Promise((resolve, reject) => {
      deps.execFile(
        deps.st,
        ['--no-compact', 'prompt', ...args],
        { timeout: 30_000, maxBuffer: 64 * 1024 * 1024 },
        (error, stdout) => {
          if (error) {
            reject(error)
            return
          }
          try {
            resolve(JSON.parse(String(stdout)))
          } catch (parseError) {
            reject(parseError)
          }
        },
      )
    })
  }

  async function revisionRows(slug: string): Promise<Row[]> {
    const listing = (await st(['revisions', slug, '--limit', '100'])) as Row | null
    const rows = Array.isArray(listing?.revisions) ? (listing.revisions as unknown[]) : []
    return rows.filter(
      (row): row is Row =>
        typeof row === 'object' &&
        row !== null &&
        typeof (row as Row).id === 'string' &&
        typeof (row as Row).content === 'string',
    )
  }

  /** Enabled prompts by name. */
  async function prompts(): Promise<Listing<InstructionPrompt>> {
    try {
      const listing = (await st(['list'])) as Row | null
      const rows = Array.isArray(listing?.prompts) ? (listing.prompts as Row[]) : []
      const items = rows
        .filter((row) => row?.enabled === true && SLUG.test(text(row.slug) ?? ''))
        .map((row) => ({
          slug: row.slug as string,
          name: text(row.name) || (row.slug as string),
          description: text(row.description) ?? '',
        }))
        .sort((a, b) => a.name.localeCompare(b.name))
      return { status: 'ready', items }
    } catch {
      return { status: 'unavailable', items: [] }
    }
  }

  /** A prompt's last 100 revisions, newest first, as `st aico create` sees them. */
  async function revisions(slug: string): Promise<Listing<InstructionRevision>> {
    if (!SLUG.test(slug)) return { status: 'unavailable', items: [] }
    try {
      const [rows, prompt] = await Promise.all([revisionRows(slug), st(['get', slug])])
      const content = text((prompt as Row | null)?.content)
      let currentSeen = false
      const items = rows.map((row) => {
        // The newest revision holding the content now, as the CLI's default.
        const current = !currentSeen && row.content === content
        if (current) currentSeen = true
        return {
          id: row.id as string,
          createdAt: text(row.created_at),
          reason: text(row.change_reason) ?? '',
          current,
          usable: usableContent(row.content as string),
        }
      })
      return { status: 'ready', items }
    } catch {
      return { status: 'unavailable', items: [] }
    }
  }

  /** The snapshot for a chosen revision; throws the owner-facing reason. */
  async function snapshot(choice: InstructionsChoice): Promise<InstructionsSnapshot> {
    let rows: Row[]
    try {
      rows = await revisionRows(choice.prompt)
    } catch {
      throw new Error(`Couldn't read ${choice.prompt} from Agent Hub`)
    }
    const row = rows.find((r) => r.id === choice.revision)
    if (!row) throw new Error(`${choice.prompt} no longer lists that revision`)
    const content = row.content as string
    if (!usableContent(content))
      throw new Error(`That revision of ${choice.prompt} can't be used as instructions`)
    return {
      prompt: choice.prompt,
      name: text(row.prompt_name) || choice.prompt,
      revision: choice.revision,
      contentHash: text(row.content_hash),
      createdAt: text(row.created_at),
      content,
    }
  }

  function registerIpc(ipcMain: IpcMain): void {
    ipcMain.handle('instructions:prompts', () => prompts())
    ipcMain.handle('instructions:revisions', (_event, slug: unknown) =>
      typeof slug === 'string' ? revisions(slug) : { status: 'unavailable', items: [] },
    )
  }

  return { prompts, revisions, snapshot, registerIpc }
}
