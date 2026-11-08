import { maskKnownSecrets } from '@aico/shared/secrets'
import type { HistoryTool, Reader, Reading } from '../types'
import { claudeReader } from './claude'
import { codexReader } from './codex'
import { piReader } from './pi'

/** Every event text a reader builds passes the exact-shape secret mask here, the one place
 * transcript text enters Tether, so the events page, the CLI and any search over the readers
 * show tokens, private keys and bearer values hidden. Totals and ids are untouched. */
function masked<S>(reader: Reader<S>): Reader<S> {
  return {
    ...reader,
    read(record, state, wantEvents) {
      const reading = reader.read(record, state, wantEvents)
      if (!wantEvents) return reading
      return {
        ...reading,
        events: reading.events.map((event) => ({ ...event, text: maskKnownSecrets(event.text) })),
      }
    },
  }
}

export const READERS: Reader[] = [claudeReader, codexReader, piReader].map((reader) =>
  masked(reader as Reader),
)

export function readerFor(tool: string): Reader | undefined {
  return READERS.find((reader) => reader.tool === (tool as HistoryTool))
}

/** One transcript line through its tool's reader; null for an empty line, one the reader skips,
 * or one that is not a JSON object. */
export function readLine<S>(
  reader: Reader<S>,
  text: string,
  state: S,
  wantEvents: boolean,
): Reading | null {
  if (!text || reader.skip?.(text)) return null
  let record: unknown
  try {
    record = JSON.parse(text)
  } catch {
    return null
  }
  if (!record || typeof record !== 'object' || Array.isArray(record)) return null
  return reader.read(record as Record<string, unknown>, state, wantEvents)
}
