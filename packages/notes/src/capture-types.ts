// The capture type table, as data: which owner takes each kind of capture and
// how (files itself, waits for one tap, keeps a copy). The default is
// capture-types.default.json; `~/.config/aico/capture-types.json` adds or
// replaces rows by id (and owners by id). A new type is a row, not code.

import { readFileSync } from 'node:fs'
import defaults from '../capture-types.default.json'

export interface CaptureTypeRow {
  id: string
  label: string
  /** Owner id, or null: nobody takes it. */
  owner: string | null
  /** What the owner calls this kind (portfolio-ai: `receipt`, `shelf_tag`). */
  owner_kind?: string
  /** Files itself, no tap. */
  auto: boolean
  /** Waits for one tap. */
  confirm: boolean
  /** Aico keeps the file and text after the hand-off. */
  keep_copy: boolean
  /** The suggestion, as a question. */
  question?: string
  /** The button for "this is not that" (the capture is retyped `dismiss_type`). */
  not_label?: string
  dismiss_type?: string
}

export interface OwnerRow {
  label: string
  /** Shown when Aico has no adapter for this owner yet. */
  later?: string
}

export interface CaptureTypeTable {
  type(id: string | null): CaptureTypeRow | null
  owner(id: string): OwnerRow
  types(): CaptureTypeRow[]
}

interface RawTable {
  owners?: Record<string, unknown>
  types?: unknown[]
}

const isObject = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value)

const text = (value: unknown): string | undefined =>
  typeof value === 'string' && value.trim() ? value : undefined

function parseType(value: unknown): CaptureTypeRow | null {
  if (!isObject(value)) return null
  const id = text(value.id)
  const label = text(value.label)
  if (!id || !label || !/^[a-z][a-z0-9_]{0,39}$/.test(id)) return null
  const owner = value.owner === null || value.owner === undefined ? null : text(value.owner)
  if (owner === undefined) return null
  return {
    id,
    label,
    owner,
    owner_kind: text(value.owner_kind),
    auto: value.auto === true,
    confirm: value.confirm === true,
    keep_copy: value.keep_copy !== false,
    question: text(value.question),
    not_label: text(value.not_label),
    dismiss_type: text(value.dismiss_type),
  }
}

function parseOwner(value: unknown): OwnerRow | null {
  if (!isObject(value)) return null
  const label = text(value.label)
  return label ? { label, later: text(value.later) } : null
}

/** Rows from a raw table; a row that is malformed is skipped and named in `problems`. */
function rows(raw: RawTable, problems: string[]) {
  const types = new Map<string, CaptureTypeRow>()
  for (const entry of raw.types ?? []) {
    const row = parseType(entry)
    if (row) types.set(row.id, row)
    else problems.push(`a type row is malformed: ${JSON.stringify(entry).slice(0, 80)}`)
  }
  const owners = new Map<string, OwnerRow>()
  for (const [id, entry] of Object.entries(raw.owners ?? {})) {
    const row = parseOwner(entry)
    if (row) owners.set(id, row)
    else problems.push(`owner ${id} is malformed`)
  }
  return { types, owners }
}

export function buildTable(overrides: RawTable | null, log: (message: string) => void = () => {}) {
  const problems: string[] = []
  const base = rows(defaults as RawTable, problems)
  if (overrides) {
    const extra = rows(overrides, problems)
    for (const [id, row] of extra.types) base.types.set(id, row)
    for (const [id, row] of extra.owners) base.owners.set(id, row)
  }
  for (const problem of problems) log(`capture types: ${problem}`)
  const table: CaptureTypeTable = {
    type: (id) => (id ? (base.types.get(id) ?? null) : null),
    owner: (id) => base.owners.get(id) ?? { label: id },
    types: () => [...base.types.values()],
  }
  return table
}

/** The default table plus the owner's file; a missing file is normal, a bad one is logged and ignored. */
export function loadCaptureTypes(
  overridePath: string | null,
  log: (message: string) => void = (message) => console.error(`[aico-web] ${message}`),
): CaptureTypeTable {
  let overrides: RawTable | null = null
  if (overridePath) {
    let content: string | null = null
    try {
      content = readFileSync(overridePath, 'utf8')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT')
        log(`capture types: can't read ${overridePath}: ${(error as Error).message}`)
    }
    if (content !== null) {
      try {
        const parsed: unknown = JSON.parse(content)
        if (isObject(parsed)) overrides = parsed as RawTable
        else log(`capture types: ${overridePath} is not an object, ignored`)
      } catch (error) {
        log(
          `capture types: ${overridePath} is not valid JSON, ignored: ${(error as Error).message}`,
        )
      }
    }
  }
  return buildTable(overrides, log)
}
