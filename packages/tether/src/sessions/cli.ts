// `tether history list|show|events` (also `aico sessions ...`): the session
// history from the running Tether (src/sessions/history.ts). `events --json`
// is the session-events dump used for debugging a reader.

import { callSocket } from '../client'
import type { TetherPaths } from '../config'
import type { EventPage, SessionDetail, SessionSummary, Tokens } from './history'
import type { SessionEvent } from './types'

export const HISTORY_USAGE = `Usage:
  aico sessions list [--tool T] [--project P] [--limit N] [--json]
      Recent sessions of Claude Code, Codex, Pi and the Aico agent, newest first.
  aico sessions show <id> [--json]
      One session: model, project, start and end, outcome, tokens, tool
      calls, files written and its subagents (an Aico agent run: the model of
      each turn). <id> is the id in the list or the start of the tool's own id.
  aico sessions events <id> [--limit N] [--before OFFSET | --from OFFSET] [--json]
      What was said and done, read from the tool's transcript. The last N by
      default (50); --before OFFSET pages back, --from OFFSET reads forward.
      --json prints the page as Tether serves it (the session-events dump).

Tokens: input is the part not served from the cache; cache read and cache
write are the cached parts; output includes reasoning.`

export interface HistoryIo {
  out(text: string): void
  err(text: string): void
}

function when(at: number | null): string {
  if (at === null) return '-'
  // Local time, as the person reading it keeps it (sv-SE prints YYYY-MM-DD HH:MM:SS).
  return new Date(at).toLocaleString('sv-SE').slice(0, 16)
}

function count(n: number): string {
  return n >= 10_000 ? `${(n / 1000).toFixed(n >= 1e6 ? 0 : 1)}k` : String(n)
}

function formatTokens(tokens: Tokens): string {
  return `in ${count(tokens.input)}, cache read ${count(tokens.cacheRead)}, cache write ${count(tokens.cacheWrite)}, out ${count(tokens.output)}`
}

function flag(args: string[], name: string): string | undefined {
  const at = args.indexOf(name)
  return at >= 0 ? args[at + 1] : undefined
}

function line(item: SessionSummary): string {
  const where = item.project ?? item.cwd ?? '-'
  return [
    item.id.padEnd(48),
    when(item.endedAt).padEnd(16),
    (item.outcome ?? 'open').padEnd(9),
    `${item.toolCalls} calls`.padEnd(11),
    (item.model ?? '-').padEnd(22),
    where,
  ].join(' ')
}

export function formatEvent(event: SessionEvent): string {
  const head = `${when(event.at)} ${event.role}${event.tool ? ` ${event.tool}` : ''}`
  const text = event.text.replace(/\s+/g, ' ').trim()
  return `[${event.offset}] ${head}: ${text.length > 300 ? `${text.slice(0, 300)}…` : text}`
}

export async function runHistory(
  io: HistoryIo,
  paths: TetherPaths,
  json: boolean,
  args: string[],
): Promise<number> {
  const [sub, ...rest] = args
  if (!sub || sub === '--help' || sub === 'help') {
    io.out(HISTORY_USAGE)
    return sub ? 0 : 2
  }
  const wantJson = json || rest.includes('--json')
  const id = rest.find((arg, index) => !arg.startsWith('--') && !isFlagValue(rest, index))
  let path: string
  const query = new URLSearchParams()
  if (sub === 'list') {
    path = '/v1/history'
    for (const name of ['tool', 'project', 'limit']) {
      const value = flag(rest, `--${name}`)
      if (value) query.set(name, value)
    }
  } else if (sub === 'show' || sub === 'events') {
    if (!id) {
      io.err(`aico sessions ${sub} needs a session id (aico sessions list shows them)`)
      return 2
    }
    path = `/v1/history/${encodeURIComponent(id)}${sub === 'events' ? '/events' : ''}`
    if (sub === 'events') {
      const limit = flag(rest, '--limit') ?? '50'
      query.set('limit', limit)
      for (const name of ['before', 'from']) {
        const value = flag(rest, `--${name}`)
        if (value) query.set(name, value)
      }
    }
  } else {
    io.err(`aico sessions: unknown command '${sub}'`)
    io.out(HISTORY_USAGE)
    return 2
  }
  let response: Awaited<ReturnType<typeof callSocket>>
  try {
    response = await callSocket(
      paths.socket,
      'GET',
      query.size ? `${path}?${query}` : path,
      undefined,
      30_000,
    )
  } catch (error) {
    io.err(
      `Tether (${paths.instance}) is not reachable at ${paths.socket}: ${(error as Error).message}`,
    )
    return 2
  }
  if (response.status !== 200) {
    const code = (response.body as { error?: string } | null)?.error ?? `http_${response.status}`
    io.err(REFUSALS[code] ?? `Tether refused: ${code}`)
    return 1
  }
  if (wantJson) {
    io.out(JSON.stringify(response.body, null, 2))
    return 0
  }
  if (sub === 'list') {
    const items = (response.body as { items: SessionSummary[] }).items
    if (!items.length)
      io.out('No sessions read yet. Tether reads new transcripts every 15 seconds.')
    for (const item of items) io.out(line(item))
    return 0
  }
  if (sub === 'show') {
    const item = response.body as SessionDetail
    io.out(`${item.id}  (${item.tool})`)
    io.out(`project: ${item.project ?? '-'}   folder: ${item.cwd ?? '-'}`)
    io.out(`model: ${item.model ?? '-'}   outcome: ${item.outcome ?? 'no final answer yet'}`)
    io.out(`started: ${when(item.startedAt)}   last activity: ${when(item.endedAt)}`)
    io.out(`tokens: ${formatTokens(item.tokens)}`)
    io.out(`tool calls: ${item.toolCalls}   files written: ${item.files.length}`)
    for (const file of item.files.slice(0, 20))
      io.out(`  ${file.path}${file.writes > 1 ? ` (x${file.writes})` : ''}`)
    if (item.files.length > 20) io.out(`  and ${item.files.length - 20} more`)
    if (item.subagents.count) {
      io.out(
        `subagents: ${item.subagents.count}, ${item.subagents.toolCalls} tool calls, tokens: ${formatTokens(item.subagents.tokens)}`,
      )
    }
    if (item.turns) {
      for (const turn of item.turns) io.out(`  turn ${turn.turn}  ${turn.model}  ${turn.stop}`)
      io.out(`messages: ${item.path}`)
      return 0
    }
    io.out(`transcript: ${item.path}`)
    return 0
  }
  const page = response.body as EventPage
  if (!page.items.length) io.out('No events in this range.')
  for (const event of page.items) io.out(formatEvent(event))
  if (page.older !== null) io.out(`older: --before ${page.older}`)
  if (page.newer !== null) io.out(`newer: --from ${page.newer}`)
  return 0
}

const VALUE_FLAGS = new Set(['--tool', '--project', '--limit', '--before', '--from'])
function isFlagValue(args: string[], index: number): boolean {
  return index > 0 && VALUE_FLAGS.has(args[index - 1] ?? '')
}

const REFUSALS: Record<string, string> = {
  unknown_session: 'No session with that id. aico sessions list shows the recent ones.',
  ambiguous_session: 'More than one session starts with that. Use more of the id.',
  transcript_gone:
    "The tool's transcript file is gone, so its events cannot be read. The totals are still kept.",
  not_found: 'This Tether is too old for session history (needs API 27). Update it.',
}
