// Pure selection-delivery helpers, kept out of `index.ts` so they unit-test
// without pulling in Electron. The record shape is shared by the sidecar,
// browser extension, web helper, and local capture tooling.

// One capture as read off the bus / pushed over SSE.
export interface SelectionRecord {
  kind?: string
  snippet?: string
  meta?: Record<string, unknown>
}

// Compact prompt reference for one or more captures. Single → `[dom: "…"]`;
// batch → `[3 items: dom "…", img "…", …]`. A capture package (from `st ui grab`,
// flagged by `meta.package`) renders as a pointer to its index so the agent opens
// the cheap text/meta before the image. Full detail stays in the bus (pullable
// via `st selection history`).
export function compactRef(records: SelectionRecord[]): string {
  const clean = (s: unknown, n: number) =>
    String(s ?? '')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, n)
  if (records.length === 1) {
    const pkg = packageRef(records[0])
    if (pkg) return pkg
    return `[${records[0].kind ?? 'dom'}: "${clean(records[0].snippet, 80)}"] `
  }
  const items = records.map((r) => `${r.kind ?? 'dom'} "${clean(r.snippet, 40)}"`).join(', ')
  return `[${records.length} items: ${items}] `
}

interface PackageMeta {
  package?: boolean
  items?: number
  w?: number
  h?: number
}

// A `st ui grab` package: the snippet is the index path (kept whole — the agent
// reads it), annotated with item count and image dims so the agent knows what it
// is getting and is told to spend tokens cheapest-first.
function packageRef(record: SelectionRecord): string | null {
  const meta = record.meta as PackageMeta | undefined
  if (!meta?.package || !record.snippet) return null
  const count = meta.items ? `${meta.items} items` : 'package'
  const dims = meta.w && meta.h ? `, image ${meta.w}×${meta.h}` : ''
  return (
    `[capture: ${record.snippet} (${count}${dims}) — open the index first; ` +
    `it ranks the text/meta/image by token cost, read cheapest-first] `
  )
}

// Parse complete SSE frames out of a rolling buffer, returning the decoded
// `data:` payloads and the unterminated remainder. Comment lines (`:` keepalive
// pings) carry no data and are dropped.
export function parseSse(buffer: string): { events: string[]; rest: string } {
  const events: string[] = []
  let rest = buffer
  let idx = rest.indexOf('\n\n')
  while (idx !== -1) {
    const frame = rest.slice(0, idx)
    rest = rest.slice(idx + 2)
    const data = frame
      .split('\n')
      .filter((l) => l.startsWith('data:'))
      .map((l) => l.slice(5).trim())
      .join('\n')
    if (data) events.push(data)
    idx = rest.indexOf('\n\n')
  }
  return { events, rest }
}
