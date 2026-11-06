// Status rows that could not be posted wait here, one file per row id, and go out the next time
// any writer reaches aico-web (or the scheduler's tick). A row is a state, not an event: a newer
// row for the same id replaces the waiting one, and a row that did go out clears its file.

import { createHash } from 'node:crypto'
import { mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { StatusRow } from './row'

const TIMEOUT_MS = 10_000

export const outboxDir = (dataDir: string) => join(dataDir, 'status-outbox')

export interface OutboxOptions {
  dir: string
  fetch?: typeof fetch
  timeoutMs?: number
}

const fileFor = (dir: string, id: string) =>
  join(dir, `${createHash('sha256').update(id).digest('hex').slice(0, 24)}.json`)

class Refused extends Error {
  constructor(readonly status: number) {
    super(`aico-web answered ${status}`)
  }
}

async function send(url: string, rows: StatusRow[], options: OutboxOptions): Promise<void> {
  const response = await (options.fetch ?? fetch)(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(rows),
    signal: AbortSignal.timeout(options.timeoutMs ?? TIMEOUT_MS),
  })
  if (!response.ok) throw new Refused(response.status)
}

function keep(dir: string, rows: StatusRow[]): void {
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  for (const row of rows) {
    const file = fileFor(dir, row.id)
    writeFileSync(`${file}.tmp`, JSON.stringify(row), { mode: 0o600 })
    renameSync(`${file}.tmp`, file)
  }
}

function waiting(dir: string): { file: string; row: StatusRow }[] {
  let names: string[]
  try {
    names = readdirSync(dir).filter((name) => name.endsWith('.json'))
  } catch {
    return []
  }
  const found: { file: string; row: StatusRow }[] = []
  for (const name of names) {
    const file = join(dir, name)
    try {
      found.push({ file, row: JSON.parse(readFileSync(file, 'utf8')) as StatusRow })
    } catch {
      rmSync(file, { force: true })
    }
  }
  return found
}

/** Sends the rows waiting from earlier attempts. Stops at the first unreachable answer; a row
 * aico-web refuses outright (4xx) will never be accepted, so it is dropped. Returns how many went out. */
export async function drainOutbox(url: string, options: OutboxOptions): Promise<number> {
  let sent = 0
  for (const { file, row } of waiting(options.dir)) {
    try {
      await send(url, [row], options)
      sent += 1
      rmSync(file, { force: true })
    } catch (error) {
      if (error instanceof Refused && error.status >= 400 && error.status < 500)
        rmSync(file, { force: true })
      else return sent
    }
  }
  return sent
}

/** Posts the rows; when aico-web cannot take them they wait in the outbox instead of being lost.
 * Null when they went out, else the reason they are waiting. Rows aico-web refuses (4xx) throw:
 * waiting would never help. */
export async function postOrKeep(
  url: string,
  rows: StatusRow[],
  options: OutboxOptions,
): Promise<string | null> {
  try {
    await send(url, rows, options)
  } catch (error) {
    if (error instanceof Refused && error.status >= 400 && error.status < 500) throw error
    keep(options.dir, rows)
    return (error as Error).message
  }
  for (const row of rows) rmSync(fileFor(options.dir, row.id), { force: true })
  await drainOutbox(url, options)
  return null
}
