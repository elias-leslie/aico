// Test harness for sync: whole hosts (a notes store and a web store, each pair
// on its own fake clock) joined by a link that can go up, go down, or drop a
// page mid-way. No sockets, no timers: a "request" is a function call on the
// server host's handle, with the answer passed through JSON as a wire would.

import { DatabaseSync } from 'node:sqlite'
import { WebStore } from '../db'
import { NotesStore } from '../notes-db'
import {
  type ChangePage,
  type Hello,
  type PeerTransport,
  type PullOptions,
  type PullResult,
  pullSet,
  type SyncHandle,
  serveChanges,
  serveHello,
} from './engine'

export const START = 1_700_000_000_000

export class FakeClock {
  constructor(public ms = START) {}
  readonly now = (): number => this.ms
  advance(ms: number): void {
    this.ms += ms
  }
}

export interface Host {
  name: string
  clock: FakeClock
  notes: NotesStore
  web: WebStore
  handles: { notes: SyncHandle; web: SyncHandle }
}

export function openHost(
  name: string,
  options: { clock?: FakeClock; notesPath?: string; webPath?: string } = {},
): Host {
  const clock = options.clock ?? new FakeClock()
  const notes = new NotesStore(options.notesPath ?? ':memory:', {
    hostName: name,
    now: clock.now,
    // Two edits in one test minute must each keep their text.
    revisionWindowMs: 0,
  })
  const web = new WebStore(options.webPath ?? ':memory:', { hostName: name, now: clock.now })
  return { name, clock, notes, web, handles: { notes: notes.syncHandle(), web: web.syncHandle() } }
}

export class Link {
  private working = true
  private dropAfter: number | null = null
  /** Requests that reached the server side, for assertions. */
  readonly requests: string[] = []

  up(): void {
    this.working = true
  }
  down(): void {
    this.working = false
  }
  get isUp(): boolean {
    return this.working
  }
  /** The next page is cut after `rows` rows: the client sees a dropped connection and gets nothing. */
  dropNextPage(rows = 1): void {
    this.dropAfter = rows
  }
  /** @internal */
  takeDrop(): number | null {
    const rows = this.dropAfter
    this.dropAfter = null
    return rows
  }
}

const wire = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T

/** What `client` sees of `server` over `link`. */
export function transport(client: Host, server: Host, link: Link): PeerTransport {
  const check = (what: string) => {
    if (!link.isUp) throw new Error(`link down (${what})`)
    link.requests.push(`${client.name}->${server.name} ${what}`)
  }
  return {
    async hello(): Promise<Hello> {
      check('hello')
      return wire(
        serveHello([server.handles.notes, server.handles.web], server.name, server.clock.now()),
      )
    },
    async changes(request): Promise<ChangePage> {
      check(`changes ${request.set} since=${request.since}`)
      const handle = server.handles[request.set as 'notes' | 'web']
      const page = wire(serveChanges(handle, request))
      const drop = link.takeDrop()
      if (drop !== null)
        throw new Error(`connection dropped after ${Math.min(drop, page.rows.length)} rows`)
      return page
    },
  }
}

export interface PullBoth {
  notes: PullResult
  web: PullResult
}

/** `client` pulls both files from `server`. */
export async function pull(
  client: Host,
  server: Host,
  link: Link,
  options: PullOptions = {},
): Promise<PullBoth> {
  const via = transport(client, server, link)
  return {
    notes: await pullSet(client.handles.notes, via, options),
    web: await pullSet(client.handles.web, via, options),
  }
}

/** Both hosts pull from each other until a whole round changes nothing. */
export async function settle(
  a: Host,
  b: Host,
  link: Link,
  options: PullOptions = {},
): Promise<number> {
  for (let round = 1; round <= 6; round += 1) {
    const results = [
      await pull(a, b, link, options),
      await pull(b, a, link, options),
      await pull(a, b, link, options),
    ]
    const changed = results.some((r) => r.notes.applied + r.web.applied > 0)
    if (!changed) return round
  }
  throw new Error('sync did not settle in 6 rounds')
}

type Snapshot = Record<string, Record<string, unknown>[]>

/** Every synced row of one file without `seq` (which differs per host), in key order. */
export function dump(handle: SyncHandle): Snapshot {
  const out: Snapshot = {}
  for (const table of handle.tables) {
    const rows = handle.db
      .prepare(`SELECT * FROM ${table.name} ORDER BY ${table.keys.join(', ')}`)
      .all() as Record<string, unknown>[]
    out[table.name] = rows.map((row) => {
      const copy = { ...row }
      delete copy.seq
      return copy
    })
  }
  return out
}

/** A copy of a store's file as a backup would hold it (a consistent snapshot). */
export function backup(handle: SyncHandle, to: string): void {
  handle.db.exec(`VACUUM INTO '${to.replace(/'/g, "''")}'`)
}

export function peek(path: string, sql: string): Record<string, unknown>[] {
  const db = new DatabaseSync(path)
  try {
    return db.prepare(sql).all() as Record<string, unknown>[]
  } finally {
    db.close()
  }
}
