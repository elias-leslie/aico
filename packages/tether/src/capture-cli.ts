// `tether capture`: read the owner's captures (photos and files saved in Aico).
// A thin HTTP client over aico-web's loopback API; no capture logic lives in
// Tether. It sends no Origin, so aico-web's guard lets it through.

import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdir, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'

export const CAPTURE_USAGE = `Usage:
  tether capture list [--status S] [--ask ID] [--limit N] [--json]
      The owner's captures, newest first. Status: new, extracting, ready,
      failed or filed.
  tether capture get <id> [--json]
      One capture: its fields, route (suggested, waiting, failed or filed, and
      which owner), caption, and the text read from it once present.
  tether capture result <id> [--json]
      What was read from the file: type, title, summary, the text, list items,
      receipt and odometer fields. Fails while the capture is still being read
      or when it could not be read. --json prints the full result.
  tether capture file <id> [--out DIR]
      Print the file's path on this host. With --out, download it into DIR
      and print that path (use this when aico-web runs on another host; that
      host's port 3002 must be in this host's forwards in hosts.json).

Talks to http://127.0.0.1:3002 (AICO_WEB_URL overrides).`

export const DEFAULT_URL = 'http://127.0.0.1:3002'
const STATUSES = ['new', 'extracting', 'ready', 'failed', 'filed']

export interface CaptureIo {
  out(text: string): void
  err(text: string): void
}

interface CaptureJson {
  id: string
  groupId: string | null
  askId: string | null
  kind: string
  name: string
  mime: string
  size: number
  hash: string | null
  caption: string
  status: string
  type: string | null
  text: string | null
  createdAt: number
  origin: string
  previewState: string
  extractError?: string | null
  extractRoute?: string | null
  needsCheck?: boolean
  route?: {
    state: string
    owner: string | null
    ownerLabel: string | null
    ownerRef: string | null
    note: string | null
    url: string | null
  } | null
  extract?: Extract | null
}

interface Extract {
  type?: string
  title?: string
  summary?: string
  text?: string
  items?: { as_written: string; item: string; quantity: string | null; struck: boolean }[]
  receipt?: {
    store: string | null
    date: string | null
    subtotal: number | null
    tax: number | null
    total: number | null
  } | null
  odometer?: { odometer: number | null; trip: number | null } | null
}

export interface Flags {
  positional: string[]
  values: Record<string, string>
  json: boolean
}

export function parseFlags(args: string[], names: readonly string[]): Flags | string {
  const flags: Flags = { positional: [], values: {}, json: false }
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index] as string
    const match = /^--([a-z-]+)(?:=(.*))?$/s.exec(arg)
    if (!match) {
      flags.positional.push(arg)
      continue
    }
    const name = match[1] as string
    if (name === 'json') {
      flags.json = true
      continue
    }
    if (!names.includes(name)) return `unknown option --${name}`
    let value = match[2]
    if (value === undefined) {
      index += 1
      value = args[index]
    }
    if (value === undefined) return `--${name} needs a value`
    flags.values[name] = value
  }
  return flags
}

/** Where aico-web keeps blobs on this host: AICO_DATA_DIR, else the folder web.db is in. */
export function blobPathHere(hash: string, env: NodeJS.ProcessEnv): string {
  const state = env.XDG_STATE_HOME || join(env.HOME || homedir(), '.local', 'state')
  const dataDir =
    env.AICO_DATA_DIR?.trim() || (env.AICO_WEB_DB ? dirname(env.AICO_WEB_DB) : join(state, 'aico'))
  return join(resolve(dataDir), 'blobs', hash.slice(0, 2), hash)
}

const kb = (bytes: number) =>
  bytes >= 1024 * 1024
    ? `${(bytes / (1024 * 1024)).toFixed(1)} MB`
    : `${Math.max(1, Math.round(bytes / 1024))} KB`

/** Local time as YYYY-MM-DD HH:MM. */
const when = (ms: number) => new Date(ms).toLocaleString('sv-SE').slice(0, 16)

function listLine(item: CaptureJson): string {
  const caption = item.caption ? `  "${item.caption.replace(/\s+/g, ' ').slice(0, 60)}"` : ''
  return `${item.id}  ${item.status.padEnd(10)} ${item.kind.padEnd(5)} ${kb(item.size).padStart(8)}  ${item.name}${caption}`
}

export function formatCapture(item: CaptureJson): string {
  const lines = [`${item.id}  ${item.name}`]
  lines.push(
    `  ${item.status} · ${item.kind} (${item.mime}) · ${kb(item.size)} · ${when(item.createdAt)} · from ${item.origin}`,
  )
  if (item.type)
    lines.push(
      `  type: ${item.type}${item.needsCheck ? ' (read by the fallback reader: check it)' : ''}`,
    )
  if (item.route) {
    const owner = item.route.owner ? ` -> ${item.route.owner}` : ''
    const ref = item.route.ownerRef ? ` (their id ${item.route.ownerRef})` : ''
    lines.push(
      `  route: ${item.route.state}${owner}${ref}${item.route.note ? `: ${item.route.note}` : ''}`,
    )
  }
  if (item.status === 'failed' && item.extractError)
    lines.push(`  could not read: ${item.extractError}`)
  if (item.extract?.title) lines.push(`  title: ${item.extract.title}`)
  if (item.extract?.summary) lines.push(`  summary: ${item.extract.summary}`)
  if (item.askId) lines.push(`  answers ask: ${item.askId}`)
  if (item.groupId) lines.push(`  group: ${item.groupId}`)
  if (item.caption) for (const line of item.caption.split('\n')) lines.push(`  caption | ${line}`)
  if (item.text) for (const line of item.text.split('\n')) lines.push(`  text | ${line}`)
  if (item.hash) lines.push(`  get the file: tether capture file ${item.id} [--out DIR]`)
  return lines.join('\n')
}

/** The reading of one capture as plain text, for an agent in a terminal. */
function formatResult(item: CaptureJson): string {
  const read = item.extract ?? {}
  const lines = [`${item.id}  ${item.type ?? 'unknown type'}${read.title ? `  ${read.title}` : ''}`]
  if (item.needsCheck) lines.push('  note: read by the fallback reader, so check it')
  if (read.summary) lines.push(`  summary: ${read.summary}`)
  if (item.text) for (const line of item.text.split('\n')) lines.push(`  text | ${line}`)
  for (const entry of read.items ?? [])
    lines.push(
      `  item | ${entry.struck ? '[struck] ' : ''}${entry.item}${entry.quantity ? ` x ${entry.quantity}` : ''}${entry.as_written !== entry.item ? ` (written: ${entry.as_written})` : ''}`,
    )
  if (read.receipt) {
    const r = read.receipt
    lines.push(
      `  receipt | ${[r.store, r.date].filter(Boolean).join(' ')} subtotal ${r.subtotal ?? '?'} tax ${r.tax ?? '?'} total ${r.total ?? '?'}`,
    )
  }
  if (read.odometer)
    lines.push(`  odometer | ${read.odometer.odometer ?? '?'} (trip ${read.odometer.trip ?? '?'})`)
  return lines.join('\n')
}

export interface Answer {
  status: number
  body: unknown
}

async function call(base: string, path: string): Promise<Answer> {
  const response = await fetch(`${base}${path}`)
  const text = await response.text()
  try {
    return { status: response.status, body: JSON.parse(text) }
  } catch {
    return { status: response.status, body: text }
  }
}

export function problem(answer: Answer): string {
  const body = answer.body as { detail?: unknown } | string | null
  const detail = typeof body === 'object' && body !== null ? body.detail : body
  return typeof detail === 'string' && detail ? detail : `HTTP ${answer.status}`
}

export async function runCapture(
  io: CaptureIo,
  json: boolean,
  args: string[],
  env: NodeJS.ProcessEnv = process.env,
): Promise<number> {
  const [sub, ...rest] = args
  const base = (env.AICO_WEB_URL?.trim() || DEFAULT_URL).replace(/\/+$/, '')
  if (sub !== 'list' && sub !== 'get' && sub !== 'result' && sub !== 'file') {
    io.err(CAPTURE_USAGE)
    return 2
  }
  const flags = parseFlags(
    rest,
    sub === 'list' ? ['status', 'ask', 'limit'] : sub === 'file' ? ['out'] : [],
  )
  if (typeof flags === 'string') {
    io.err(`tether capture: ${flags}`)
    return 2
  }
  const asJson = json || flags.json

  let path: string
  if (sub === 'list') {
    if (flags.positional.length) {
      io.err(`tether capture: unexpected ${flags.positional[0]}`)
      return 2
    }
    const status = flags.values.status
    if (status !== undefined && !STATUSES.includes(status)) {
      io.err(`tether capture: --status takes one of ${STATUSES.join(', ')}`)
      return 2
    }
    const query = new URLSearchParams()
    for (const name of ['status', 'ask', 'limit'] as const)
      if (flags.values[name] !== undefined) query.set(name, flags.values[name] as string)
    path = `/api/captures${query.size ? `?${query}` : ''}`
  } else {
    if (flags.positional.length !== 1) {
      io.err(CAPTURE_USAGE)
      return 2
    }
    path = `/api/captures/${encodeURIComponent(flags.positional[0] as string)}`
  }

  let answer: Answer
  try {
    answer = await call(base, path)
  } catch (error) {
    io.err(
      `tether capture: Aico is not reachable at ${base} (${(error as Error).message}). Is aico-web running on this host, or its port forwarded?`,
    )
    return 2
  }
  if (answer.status < 200 || answer.status >= 300) {
    io.err(`tether capture: ${problem(answer)}`)
    return 1
  }

  if (sub === 'list') {
    const body = answer.body as { captures: CaptureJson[]; total: number }
    if (asJson) io.out(JSON.stringify(body, null, 2))
    else if (!body.captures.length) io.out('No captures.')
    else {
      for (const item of body.captures) io.out(listLine(item))
      if (body.total > body.captures.length)
        io.out(`(${body.captures.length} of ${body.total}; use --limit N for more)`)
    }
    return 0
  }

  const item = answer.body as CaptureJson
  if (sub === 'get') {
    io.out(asJson ? JSON.stringify(item, null, 2) : formatCapture(item))
    return 0
  }

  if (sub === 'result') {
    if (item.status === 'new' || item.status === 'extracting') {
      io.err(
        `tether capture: ${item.id} is still ${item.status === 'new' ? 'waiting to be read' : 'being read'}; try again shortly`,
      )
      return 3
    }
    if (item.status === 'failed') {
      io.err(
        `tether capture: ${item.id} could not be read${item.extractError ? `: ${item.extractError}` : ''}`,
      )
      return 1
    }
    if (asJson)
      io.out(
        JSON.stringify(
          {
            id: item.id,
            status: item.status,
            type: item.type,
            text: item.text,
            needsCheck: item.needsCheck ?? false,
            route: item.extractRoute ?? null,
            extract: item.extract ?? null,
          },
          null,
          2,
        ),
      )
    else io.out(formatResult(item))
    return 0
  }

  // file
  if (!item.hash) {
    io.err(`tether capture: the file for ${item.id} was handed off and is no longer kept`)
    return 1
  }
  const out = flags.values.out
  if (out === undefined) {
    const here = blobPathHere(item.hash, env)
    if (!existsSync(here)) {
      io.err(
        `tether capture: ${item.id} is not stored on this host. Download it with: tether capture file ${item.id} --out DIR`,
      )
      return 1
    }
    io.out(asJson ? JSON.stringify({ id: item.id, name: item.name, path: here }) : here)
    return 0
  }
  let download: Response
  try {
    download = await fetch(`${base}/api/captures/${encodeURIComponent(item.id)}/file`)
  } catch (error) {
    io.err(`tether capture: download failed: ${(error as Error).message}`)
    return 2
  }
  if (!download.ok) {
    io.err(`tether capture: download failed: HTTP ${download.status}`)
    return 1
  }
  const bytes = Buffer.from(await download.arrayBuffer())
  if (createHash('sha256').update(bytes).digest('hex') !== item.hash) {
    io.err('tether capture: the downloaded file does not match its hash; nothing was saved')
    return 1
  }
  const dir = resolve(out)
  await mkdir(dir, { recursive: true })
  const target = join(dir, `${item.id}-${basename(item.name)}`)
  await writeFile(target, bytes, { mode: 0o600 })
  io.out(asJson ? JSON.stringify({ id: item.id, name: item.name, path: target }) : target)
  return 0
}
