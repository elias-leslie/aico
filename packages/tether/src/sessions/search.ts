// Text search over the transcripts the history keeps rows for. Nothing is indexed or
// copied: each file is read in big chunks, a cheap case-blind scan of the raw bytes finds the
// lines that can match, and only those lines are parsed by the tool's reader. What the
// reader builds is already masked (readers/index.ts), so a hit shows what Recent shows.

import { open } from 'node:fs/promises'
import { readerFor } from './readers'
import type { EventKind, EventRole, HistoryTool, Reader } from './types'

/** What one search may spend, shared by all the files it reads. */
export interface SearchRun {
  /** Bytes read so far. */
  bytes: number
  maxBytes: number
  /** Time (`now()`) the search must end by. */
  deadline: number
  now: () => number
  /** The caller gave up (the connection closed). */
  signal?: AbortSignal
  sliceMs?: number
}

/** Why a search ended before the end of the history, or null: it can go on. */
export function stopOf(run: SearchRun): 'budget' | 'cancelled' | null {
  if (run.signal?.aborted) return 'cancelled'
  return run.bytes >= run.maxBytes || run.now() >= run.deadline ? 'budget' : null
}

/** A match in a conversation: the event it is in and a few words around it. */
export interface SearchHit {
  /** Byte offset of the transcript line (`aico recent events ID --from OFFSET`). */
  offset: number
  at: number | null
  role: EventRole
  kind: EventKind
  tool?: string
  snippet: string
}

export interface SearchedFile {
  path: string
  tool: string
}

const CHUNK = 8 << 20
/** How long the scan runs before it hands the event loop back (Tether answers others between). */
const SLICE_MS = 15
const SNIPPET_RADIUS = 70
/** What is searched: what was said and the commands run, not tool output or thinking. */
const SEARCHED_KINDS: ReadonlySet<EventKind> = new Set(['text', 'tool_call'])

// Non-ASCII too: the raw scan lowercases only ASCII bytes (É and é differ there), and some
// writers escape it as \uXXXX. Such a letter ends the plain stretch; the parsed line decides.
// biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are what JSON escapes
const JSON_ESCAPED = /["\\/<>&\u0000-\u001f\u0080-\uffff]+/

/** The longest stretch of the query that reads the same in the raw JSON line (ASCII with no
 * quote, backslash, slash, angle bracket, ampersand or control character, which JSON may
 * escape). Empty when the query has no such stretch: then every line is parsed. */
export function prefilterNeedle(query: string): string {
  let best = ''
  for (const run of query.split(JSON_ESCAPED)) {
    if (run.length > best.length) best = run
  }
  return best
}

/** The text with the match in the middle, on one line. */
export function snippetAround(text: string, needle: string): string {
  const flat = text.replace(/\s+/g, ' ')
  const at = flat.toLowerCase().indexOf(needle)
  if (at < 0) return flat.slice(0, SNIPPET_RADIUS * 2)
  const start = Math.max(0, at - SNIPPET_RADIUS)
  const end = Math.min(flat.length, at + needle.length + SNIPPET_RADIUS)
  return `${start > 0 ? '…' : ''}${flat.slice(start, end).trim()}${end < flat.length ? '…' : ''}`
}

/** Latin-1 view of the bytes, lowercased: one char per byte, so offsets carry over. */
function raw(buffer: Buffer): string {
  return buffer.toString('latin1').toLowerCase()
}

/** The `[start, end)` of each line that can hold the prefilter (every line when it is empty). */
function* candidates(text: string, prefilter: string): Generator<[number, number]> {
  if (!prefilter) {
    for (let start = 0; start < text.length; ) {
      let end = text.indexOf('\n', start)
      if (end < 0) end = text.length
      yield [start, end]
      start = end + 1
    }
    return
  }
  for (let at = text.indexOf(prefilter); at >= 0; ) {
    const start = text.lastIndexOf('\n', at) + 1
    let end = text.indexOf('\n', at)
    if (end < 0) end = text.length
    yield [start, end]
    at = text.indexOf(prefilter, end + 1)
  }
}

const nextTurn = () => new Promise<void>((resolve) => setImmediate(resolve))

/**
 * Every hit of `query` (a phrase, case-blind) in one transcript, oldest line first, and
 * how many events matched in all. `keep` bounds the hits returned, not the count. With a
 * `run`, the read stops at its budget (`complete` false), and the scan hands the event loop
 * back every few milliseconds.
 */
export async function searchFile(
  file: SearchedFile,
  query: string,
  keep: number,
  run?: SearchRun,
): Promise<{ matches: number; hits: SearchHit[]; bytes: number; complete: boolean }> {
  const reader: Reader | undefined = readerFor(file.tool as HistoryTool)
  const out = { matches: 0, hits: [] as SearchHit[], bytes: 0, complete: true }
  if (!reader) return out
  const needle = query.toLowerCase()
  const prefilter = raw(Buffer.from(prefilterNeedle(query), 'utf8'))
  const handle = await open(file.path, 'r').catch(() => null)
  if (!handle) return out
  let sliceAt = performance.now()
  const breathe = async () => {
    if (performance.now() - sliceAt < (run?.sliceMs ?? SLICE_MS)) return
    await nextTurn()
    sliceAt = performance.now()
  }
  try {
    const state = reader.initialState()
    let position = 0
    let carry: Buffer = Buffer.alloc(0)
    for (;;) {
      if (run && stopOf(run)) {
        out.complete = false
        break
      }
      const chunk = Buffer.allocUnsafe(CHUNK)
      const { bytesRead } = await handle.read(chunk, 0, CHUNK, position)
      out.bytes += bytesRead
      if (run) run.bytes += bytesRead
      const last = bytesRead < CHUNK
      const buffer = carry.length
        ? Buffer.concat([carry, chunk.subarray(0, bytesRead)])
        : chunk.subarray(0, bytesRead)
      const base = position - carry.length
      position += bytesRead
      // Keep the incomplete last line for the next chunk; at the end it is a line too.
      const cut = last ? buffer.length : buffer.lastIndexOf(10) + 1
      if (cut === 0 && !last) {
        carry = buffer
        continue
      }
      carry = buffer.subarray(cut)
      const text = raw(buffer.subarray(0, cut))
      for (const [start, end] of candidates(text, prefilter)) {
        read(reader, state, buffer.subarray(start, end), base + start, needle, keep, out)
        await breathe()
      }
      if (last) break
      await breathe()
    }
  } finally {
    await handle.close()
  }
  return out
}

function read(
  reader: Reader,
  state: Record<string, unknown>,
  line: Buffer,
  offset: number,
  needle: string,
  keep: number,
  out: { matches: number; hits: SearchHit[] },
): void {
  const text = line.toString('utf8')
  if (!text || reader.skip?.(text)) return
  let record: unknown
  try {
    record = JSON.parse(text)
  } catch {
    return
  }
  if (!record || typeof record !== 'object' || Array.isArray(record)) return
  for (const event of reader.read(record as Record<string, unknown>, state, true).events) {
    if (!SEARCHED_KINDS.has(event.kind) || !event.text.toLowerCase().includes(needle)) continue
    out.matches += 1
    if (out.hits.length < keep) {
      out.hits.push({
        offset,
        at: event.at,
        role: event.role,
        kind: event.kind,
        ...(event.tool ? { tool: event.tool } : {}),
        snippet: snippetAround(event.text, needle),
      })
    }
  }
}
