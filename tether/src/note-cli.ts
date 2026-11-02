// `tether note`: read the owner's notes and add to them (including the
// Groceries list). A thin HTTP client over aico-web's loopback API; no note
// logic lives in Tether. It sends no Origin, so aico-web's guard lets it through.

import { type Answer, type CaptureIo, DEFAULT_URL, parseFlags, problem } from './capture-cli'

export const NOTE_USAGE = `Usage:
  tether note list [--kind note|list|prompt] [--label L] [--q TEXT] [--limit N] [--json]
      The owner's notes, pinned first then newest. Lists show how many items
      are open and done. --q searches titles, text, items and labels.
  tether note get <id> [--json]
      One note: text, labels, items (with their ids) and attached files.
  tether note add "title" [--body TEXT] [--list] [--json]
      Make a note; --list makes it a checklist.
  tether note item add <id> "text" [--json]
      Add an item to a checklist.
  tether note item check <id> <item-id> [--json]
  tether note item uncheck <id> <item-id> [--json]
  tether note groceries show [--json]
      The Groceries list (made on first use).
  tether note groceries add "text"... [--json]
      Add one item for each argument.

The id "groceries" works anywhere an id does.
Talks to http://127.0.0.1:3002 (AICO_WEB_URL overrides).`

interface ItemJson {
  id: string
  text: string
  checked: boolean
  hint: string | null
}

interface NoteJson {
  id: string
  kind: string
  title: string
  pinned: boolean
  archived: boolean
  editedAt: number
  labels: string[]
  unchecked?: number
  checked?: number
  snippet?: string
  body?: string
  items?: ItemJson[]
  attachments?: { name: string; mime: string }[]
}

const when = (ms: number) => new Date(ms).toISOString().replace('T', ' ').slice(0, 16)

function listLine(note: NoteJson): string {
  const counts =
    note.kind === 'list' || note.unchecked || note.checked
      ? `  [${note.unchecked ?? 0} open, ${note.checked ?? 0} done]`
      : ''
  const labels = note.labels.length ? `  #${note.labels.join(' #')}` : ''
  const flags = `${note.pinned ? '*' : ' '}${note.archived ? 'a' : ' '}`
  return `${note.id}  ${note.kind.padEnd(6)} ${flags} ${note.title || '(untitled)'}${counts}${labels}`
}

export function formatNote(note: NoteJson): string {
  const lines = [`${note.id}  ${note.title || '(untitled)'}`]
  lines.push(
    `  ${note.kind}${note.pinned ? ' · pinned' : ''}${note.archived ? ' · archived' : ''} · edited ${when(note.editedAt)}`,
  )
  if (note.labels.length) lines.push(`  labels: ${note.labels.join(', ')}`)
  for (const line of (note.body ?? '').split('\n')) if (line) lines.push(`  | ${line}`)
  const items = note.items ?? []
  // Open items first, so a long list's done items do not bury what is left.
  for (const item of [...items.filter((i) => !i.checked), ...items.filter((i) => i.checked)])
    lines.push(
      `  [${item.checked ? 'x' : ' '}] ${item.id}  ${item.text}${item.hint ? `  (${item.hint})` : ''}`,
    )
  for (const file of note.attachments ?? []) lines.push(`  file: ${file.name} (${file.mime})`)
  return lines.join('\n')
}

async function call(base: string, method: string, path: string, body?: unknown): Promise<Answer> {
  const response = await fetch(`${base}${path}`, {
    method,
    ...(body === undefined
      ? {}
      : { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }),
  })
  const text = await response.text()
  try {
    return { status: response.status, body: JSON.parse(text) }
  } catch {
    return { status: response.status, body: text }
  }
}

const enc = encodeURIComponent

export async function runNote(
  io: CaptureIo,
  json: boolean,
  args: string[],
  env: NodeJS.ProcessEnv = process.env,
): Promise<number> {
  const base = (env.AICO_WEB_URL?.trim() || DEFAULT_URL).replace(/\/+$/, '')
  const fail = (message: string) => {
    io.err(`tether note: ${message}`)
    return 2
  }

  const [sub, ...rest] = args
  let words = rest
  let group: string | undefined
  if (sub === 'item' || sub === 'groceries') {
    group = rest[0]
    words = rest.slice(1)
  }
  // `--list` takes no value, but parseFlags wants one for every named flag.
  const isList = sub === 'add' && words.includes('--list')
  if (isList) words = words.filter((word) => word !== '--list')
  const flags = parseFlags(
    words,
    sub === 'list' ? ['kind', 'label', 'q', 'limit'] : sub === 'add' ? ['body'] : [],
  )
  if (typeof flags === 'string') return fail(flags)
  const asJson = json || flags.json
  const positional = flags.positional

  let method = 'GET'
  let path: string
  let body: unknown
  let print: (answer: unknown) => string

  if (sub === 'list') {
    if (positional.length) return fail(`unexpected ${positional[0]}`)
    const query = new URLSearchParams()
    for (const name of ['kind', 'label', 'q', 'limit'] as const)
      if (flags.values[name] !== undefined) query.set(name, flags.values[name] as string)
    path = `/api/notes${query.size ? `?${query}` : ''}`
    print = (answer) => {
      const { notes, total } = answer as { notes: NoteJson[]; total: number }
      if (!notes.length) return 'No notes.'
      const lines = notes.map(listLine)
      if (total > notes.length) lines.push(`(${notes.length} of ${total}; use --limit N for more)`)
      return lines.join('\n')
    }
  } else if (sub === 'get') {
    if (positional.length !== 1) return fail('get takes one note id')
    path = `/api/notes/${enc(positional[0] as string)}`
    print = (answer) => formatNote(answer as NoteJson)
  } else if (sub === 'add') {
    const title = positional[0]
    if (positional.length !== 1 || !title) return fail('add takes one title')
    method = 'POST'
    path = '/api/notes'
    body = {
      title,
      ...(flags.values.body !== undefined ? { body: flags.values.body } : {}),
      kind: isList ? 'list' : 'note',
    }
    print = (answer) => `${(answer as NoteJson).id}  ${(answer as NoteJson).title}`
  } else if (sub === 'item' && group === 'add') {
    if (positional.length !== 2) return fail('item add takes a note id and the item text')
    method = 'POST'
    path = `/api/notes/${enc(positional[0] as string)}/items`
    body = { text: positional[1] }
    print = (answer) => `${(answer as ItemJson).id}  ${(answer as ItemJson).text}`
  } else if (sub === 'item' && (group === 'check' || group === 'uncheck')) {
    if (positional.length !== 2) return fail(`item ${group} takes a note id and an item id`)
    method = 'PATCH'
    path = `/api/notes/${enc(positional[0] as string)}/items/${enc(positional[1] as string)}`
    body = { checked: group === 'check' }
    print = (answer) => {
      const item = answer as ItemJson
      return `[${item.checked ? 'x' : ' '}] ${item.id}  ${item.text}`
    }
  } else if (sub === 'groceries' && group === 'show') {
    if (positional.length) return fail(`unexpected ${positional[0]}`)
    path = '/api/notes/groceries'
    print = (answer) => formatNote(answer as NoteJson)
  } else if (sub === 'groceries' && group === 'add') {
    if (!positional.length) return fail('groceries add takes the items to add')
    const added: ItemJson[] = []
    for (const text of positional) {
      const answer = await send(io, base, 'POST', '/api/notes/groceries/items', { text })
      if (typeof answer === 'number') return answer
      added.push(answer as ItemJson)
    }
    io.out(
      asJson ? JSON.stringify(added, null, 2) : added.map((i) => `${i.id}  ${i.text}`).join('\n'),
    )
    return 0
  } else {
    io.err(NOTE_USAGE)
    return 2
  }

  const answer = await send(io, base, method, path, body)
  if (typeof answer === 'number') return answer
  io.out(asJson ? JSON.stringify(answer, null, 2) : print(answer))
  return 0
}

/** The answer's body, or an exit code (1: Aico said no; 2: Aico is not reachable). */
async function send(
  io: CaptureIo,
  base: string,
  method: string,
  path: string,
  body?: unknown,
): Promise<unknown | number> {
  let answer: Answer
  try {
    answer = await call(base, method, path, body)
  } catch (error) {
    io.err(
      `tether note: Aico is not reachable at ${base} (${(error as Error).message}). Is aico-web running on this host, or its port forwarded?`,
    )
    return 2
  }
  if (answer.status < 200 || answer.status >= 300) {
    io.err(`tether note: ${problem(answer)}`)
    return 1
  }
  return answer.body
}
