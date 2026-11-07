// The notes owner: it lives inside Aico, so a capture is filed by writing rows,
// not by sending bytes. A grocery list adds its items to the Groceries list
// (unchecked, even the ones the reader saw struck out, which keep a hint);
// a note, recipe or document becomes a note of its own. Both attach the
// photo and are safe to run again for the same capture.

import type { NotesStore } from '../notes-db'
import type { HandOff, HandOffResult, OwnerAdapter } from './types'

interface Reading {
  title?: unknown
  text?: unknown
  items?: { item?: unknown; as_written?: unknown; quantity?: unknown; struck?: unknown }[]
}

const words = (value: unknown): string => (typeof value === 'string' ? value.trim() : '')

function parse(json: string | null): Reading {
  try {
    const value = JSON.parse(json ?? 'null') as Reading | null
    return value && typeof value === 'object' ? value : {}
  } catch {
    return {}
  }
}

/** "apples (3 bags)" for an item with a quantity, else the plain item. */
function groceryLine(entry: NonNullable<Reading['items']>[number]): string {
  const name = words(entry.item) || words(entry.as_written)
  const quantity = words(entry.quantity)
  return name && quantity ? `${name} (${quantity})` : name
}

/** A title for a note whose reading gave none: the first line of its text, else the file name. */
function fallbackTitle(text: string, name: string): string {
  const first = text.split('\n').find((line) => line.trim())
  return (first?.trim().slice(0, 80) || name).slice(0, 200)
}

export class NotesOwner implements OwnerAdapter {
  readonly local = true

  constructor(private readonly store: NotesStore) {}

  async send(job: HandOff): Promise<HandOffResult> {
    const row = job.capture
    if (!row.hash) return { state: 'failed', reason: 'The file is no longer on this computer' }
    const file = {
      captureId: row.id,
      hash: row.hash,
      name: row.name,
      mime: row.mime,
      size: row.size,
    }
    const reading = parse(row.extract_json)
    if (job.kind === 'grocery_list') {
      const items = (reading.items ?? [])
        .map((entry) => ({
          text: groceryLine(entry),
          hint: entry.struck === true ? 'struck' : null,
        }))
        .filter((item) => item.text)
      if (items.length === 0)
        return { state: 'failed', reason: "I couldn't find any items on that list" }
      return { state: 'filed', ref: this.store.notes.fileGroceries(file, items).noteId }
    }
    const text = words(row.text) ? (row.text as string) : ''
    return {
      state: 'filed',
      ref: this.store.notes.fileNote(file, {
        title: words(reading.title) || fallbackTitle(text, row.name),
        body: text || row.caption,
        project: row.project,
      }),
    }
  }

  async reachable(): Promise<boolean> {
    return true
  }
}
