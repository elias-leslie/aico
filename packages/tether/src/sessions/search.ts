// Text search over the transcripts the history keeps rows for. Nothing is indexed or
// copied: each file is read in big chunks, a cheap case-blind scan of the raw bytes finds the
// lines that can match, and only those lines are parsed by the tool's reader. What the
// reader builds is already masked (readers/index.ts), so a hit shows what Recent shows.

import { open } from 'node:fs/promises'
import { readerFor } from './readers'
import type { EventKind, EventRole, HistoryTool, Reader } from './types'

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
const SNIPPET_RADIUS = 70
/** What is searched: what was said and the commands run, not tool output or thinking. */
const SEARCHED_KINDS: ReadonlySet<EventKind> = new Set(['text', 'tool_call'])

// biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are what JSON escapes
const JSON_ESCAPED = /["\\/<>&\u0000-\u001f\u2028\u2029]+/

/** The longest stretch of the query that reads the same in the raw JSON line (no quote,
 * backslash, slash, angle bracket, ampersand or control character, which JSON may escape). */
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

/**
 * Every hit of `query` (a phrase, case-blind) in one transcript, oldest line first, and
 * how many events matched in all. `keep` bounds the hits returned, not the count.
 */
export async function searchFile(
  file: SearchedFile,
  query: string,
  keep: number,
): Promise<{ matches: number; hits: SearchHit[]; bytes: number }> {
  const reader: Reader | undefined = readerFor(file.tool as HistoryTool)
  const out = { matches: 0, hits: [] as SearchHit[], bytes: 0 }
  if (!reader) return out
  const needle = query.toLowerCase()
  const prefilter = raw(Buffer.from(prefilterNeedle(query), 'utf8'))
  const handle = await open(file.path, 'r').catch(() => null)
  if (!handle) return out
  try {
    const state = reader.initialState()
    let position = 0
    let carry: Buffer = Buffer.alloc(0)
    for (;;) {
      const chunk = Buffer.allocUnsafe(CHUNK)
      const { bytesRead } = await handle.read(chunk, 0, CHUNK, position)
      out.bytes += bytesRead
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
      for (let at = text.indexOf(prefilter); at >= 0; ) {
        const start = text.lastIndexOf('\n', at) + 1
        let end = text.indexOf('\n', at)
        if (end < 0) end = text.length
        read(reader, state, buffer.subarray(start, end), base + start, needle, keep, out)
        at = text.indexOf(prefilter, end)
      }
      if (last) break
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
