// What was sent to an agent and has not shown up in its transcript yet: the one
// thing a crash can take that nothing else holds. Tether keeps a small record
// per agent session until the text appears in that session's own record
// (ModelWatch reads it anyway; nothing new polls) or a recovery has put it back
// in the resumed prompt, then drops it. Text only, a plain append with no fsync,
// mode 0600. Shells never get here (Recovery.noteInput), so a typed password
// isn't recorded.

import { appendFileSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { ownerSaid } from './recovery-facts'

export interface PendingInput {
  at: number
  text: string
  /** Sent with Enter, or still being typed when the view lost the session. */
  state: 'sent' | 'typed'
  /** The sending session, when another session sent it. */
  from?: string
  /** Rebuilt from keystrokes that moved the cursor: the text may differ. */
  approx?: true
}

const MAX_ENTRIES = 8
const MAX_TEXT_BYTES = 8 * 1024
const MAX_SESSION_BYTES = 16 * 1024
/** Nothing an agent still has queued is this old. */
const KEEP_MS = 24 * 3600_000
/** The record of a send can reach Tether just after the agent wrote it. */
const LATE_RECORD_MS = 5_000
/** Shorter than this, a text inside a longer message says nothing: `ok` is in many. */
const FOUND_INSIDE_CHARS = 24

/** What two spellings of one message have in common: terminals, pastes and
 * transcripts differ in line ends and spacing. */
function comparable(text: string): string {
  return (
    text
      // biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are what differs
      .replace(/[\u0000- \u007f-\u009f]+/g, ' ')
      .trim()
  )
}

function clip(text: string): string {
  if (Buffer.byteLength(text) <= MAX_TEXT_BYTES) return text
  return Buffer.from(text).subarray(0, MAX_TEXT_BYTES).toString('utf8').replace(/�+$/, '')
}

export class PendingInputs {
  private readonly sessions = new Map<string, PendingInput[]>()

  constructor(
    private readonly dir: string,
    private readonly now: () => number = Date.now,
  ) {
    mkdirSync(dir, { recursive: true, mode: 0o700 })
    for (const name of readdirSync(dir)) {
      if (name.endsWith('.jsonl')) this.load(name.slice(0, -'.jsonl'.length))
      else rmSync(join(dir, name), { force: true }) // A rewrite a crash cut short.
    }
  }

  private path(id: string): string {
    return join(this.dir, `${id}.jsonl`)
  }

  private load(id: string): void {
    const entries: PendingInput[] = []
    let torn = false
    let text = ''
    try {
      text = readFileSync(this.path(id), 'utf8')
    } catch {
      return
    }
    for (const line of text.split('\n')) {
      // A power cut can leave a torn last line.
      try {
        const entry = line ? (JSON.parse(line) as PendingInput) : null
        if (entry && typeof entry.at === 'number' && typeof entry.text === 'string')
          entries.push(entry)
      } catch {
        torn = true
      }
    }
    if (!entries.length) rmSync(this.path(id), { force: true })
    else if (torn)
      this.write(id, entries) // Or the next append would join the torn line.
    else this.sessions.set(id, entries)
  }

  private write(id: string, entries: PendingInput[]): void {
    if (!entries.length) {
      this.sessions.delete(id)
      rmSync(this.path(id), { force: true })
      return
    }
    this.sessions.set(id, entries)
    const tmp = `${this.path(id)}.${process.pid}.tmp`
    appendFileSync(tmp, entries.map((entry) => `${JSON.stringify(entry)}\n`).join(''), {
      mode: 0o600,
    })
    renameSync(tmp, this.path(id))
  }

  add(id: string, input: Omit<PendingInput, 'at'>, at = this.now()): void {
    const entry: PendingInput = { ...input, at, text: clip(input.text) }
    const entries = [...(this.sessions.get(id) ?? []), entry]
    let bytes = entries.reduce((sum, e) => sum + Buffer.byteLength(e.text), 0)
    let dropped = false
    while (entries.length > MAX_ENTRIES || bytes > MAX_SESSION_BYTES) {
      bytes -= Buffer.byteLength(entries.shift()?.text ?? '')
      dropped = true
    }
    if (dropped) {
      this.write(id, entries)
      return
    }
    this.sessions.set(id, entries)
    appendFileSync(this.path(id), `${JSON.stringify(entry)}\n`, { mode: 0o600 })
  }

  has(id: string): boolean {
    return this.sessions.has(id)
  }

  /** While the agent runs, a day-old entry has stopped waiting. A session that's
   * down keeps its own, however long the machine stays off. */
  expire(id: string): void {
    const entries = this.sessions.get(id)
    if (!entries) return
    const kept = entries.filter((entry) => this.now() - entry.at < KEEP_MS)
    if (kept.length !== entries.length) this.write(id, kept)
  }

  list(id: string): PendingInput[] {
    return [...(this.sessions.get(id) ?? [])]
  }

  /** `text` reached the agent at `at`. Agents take messages in order, so what
   * was sent before it arrived too. An entry that was still being typed, or
   * whose text is only approximate, can't be found: it ends when it's next in
   * line and the owner says something else, since that came after it. */
  seen(id: string, text: string, at: number | null): void {
    const entries = this.sessions.get(id)
    if (!entries) return
    const when = at ?? this.now()
    const arrived = comparable(text)
    const rows = new Set(text.split('\n').map(comparable))
    const inexact = (entry: PendingInput) => entry.state === 'typed' || entry.approx === true
    let last = -1
    entries.forEach((entry, index) => {
      const sent = comparable(entry.text)
      if (!sent || inexact(entry) || entry.at - LATE_RECORD_MS > when) return
      if (
        sent === arrived ||
        rows.has(sent) ||
        (sent.length >= FOUND_INSIDE_CHARS && arrived.includes(sent))
      )
        last = index
    })
    if (last >= 0) {
      this.write(id, entries.slice(last + 1))
      return
    }
    if (!ownerSaid(text)) return
    let first = 0
    while (
      first < entries.length &&
      inexact(entries[first] as PendingInput) &&
      (entries[first] as PendingInput).at <= when
    )
      first += 1
    if (first) this.write(id, entries.slice(first))
  }

  /** These were shown (a resumed prompt); entries added since stay. */
  remove(id: string, shown: readonly PendingInput[]): void {
    const entries = this.sessions.get(id)
    if (!entries) return
    const gone = new Set(shown.map((entry) => `${entry.at}:${entry.text}`))
    this.write(
      id,
      entries.filter((entry) => !gone.has(`${entry.at}:${entry.text}`)),
    )
  }

  forget(id: string): void {
    if (this.sessions.has(id)) this.write(id, [])
  }

  /** Drop what belongs to sessions that no longer exist. */
  retain(exists: (id: string) => boolean): void {
    for (const id of [...this.sessions.keys()]) if (!exists(id)) this.forget(id)
  }
}
