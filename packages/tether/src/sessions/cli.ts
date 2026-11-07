// `tether history list|show|events` (also `aico recent ...`): the session
// history from the running Tether (src/sessions/history.ts). `events --json`
// is the session-events dump used for debugging a reader.

import { localTime } from '@aico/shared/time'
import { callSocket } from '../client'
import type { TetherPaths } from '../config'
import type { EventPage, SessionDetail, SessionSummary, Tokens } from './history'
import type { SessionEvent } from './types'

export const HISTORY_USAGE = `Usage:
  aico recent list [--tool T] [--project P] [--limit N] [--json]
      Recent sessions of Claude Code, Codex, Pi and the Aico agent, newest first.
  aico recent show <id> [--json]
      One session: model, project, start and end, outcome, tokens, tool
      calls, files written and its subagents (an Aico agent run: the model of
      each turn). <id> is the id in the list or the start of the tool's own id.
  aico recent events <id> [--limit N] [--before OFFSET | --from OFFSET] [--json]
      What was said and done, one readable line each (long text is cut), read
      from the tool's transcript. The last N by default (50); --before OFFSET
      pages back, --from OFFSET reads forward. --json prints the whole records.

Tokens: input is the part not served from the cache; cache read and cache
write are the cached parts; output includes reasoning.`

export interface HistoryIo {
  out(text: string): void
  err(text: string): void
}

function when(at: number | null): string {
  return at === null ? '-' : localTime(at)
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

/** The id with the shortest start that is still unique in the list (at least 8 characters of the tool's own id). */
export function shortIds(ids: string[]): string[] {
  return ids.map((id) => {
    const colon = id.indexOf(':')
    const tool = id.slice(0, colon + 1)
    const native = id.slice(colon + 1)
    let length = Math.min(8, native.length)
    while (
      length < native.length &&
      ids.some((other) => other !== id && other.startsWith(`${tool}${native.slice(0, length)}`))
    )
      length += 1
    return `${tool}${native.slice(0, length)}`
  })
}

const OUTCOMES =
  'OUTCOME: completed (it gave a final answer), aborted, error, open (no final answer yet). Times are local.'

function table(items: SessionSummary[]): string[] {
  const ids = shortIds(items.map((item) => item.id))
  const width = Math.max(2, ...ids.map((id) => id.length))
  const cells = (
    id: string,
    last: string,
    outcome: string,
    calls: string,
    model: string,
    where: string,
  ) =>
    [
      id.padEnd(width),
      last.padEnd(20),
      outcome.padEnd(10),
      calls.padEnd(6),
      model.padEnd(22),
      where,
    ]
      .join(' ')
      .trimEnd()
  return [
    cells('ID', 'LAST ACTIVITY', 'OUTCOME', 'CALLS', 'MODEL', 'PROJECT'),
    ...items.map((item, index) =>
      cells(
        ids[index] as string,
        when(item.endedAt),
        item.outcome ?? 'open',
        String(item.toolCalls),
        item.model ?? '-',
        item.project ?? item.cwd ?? '-',
      ),
    ),
    OUTCOMES,
  ]
}

const flat = (text: string) => text.replace(/\s+/g, ' ').trim()
const clip = (text: string, max: number) =>
  text.length > max ? `${text.slice(0, max - 1)}…` : text

/** One event for a person: when, who or what, and the gist. Raw records are --json. */
export function formatEvent(event: SessionEvent): string {
  const text = flat(event.text)
  const tool = event.tool ?? 'tool'
  const label =
    event.kind === 'tool_call'
      ? `${tool} call`
      : event.kind === 'tool_result'
        ? 'result'
        : event.kind === 'thinking'
          ? 'thinking'
          : event.role === 'user'
            ? 'you'
            : event.role === 'assistant'
              ? 'assistant'
              : event.role
  const body = clip(text, event.kind === 'tool_result' || event.kind === 'thinking' ? 120 : 220)
  return `${when(event.at).padEnd(20)} ${label.padEnd(12)} ${body}`.trimEnd()
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
      io.err(`aico recent ${sub} needs a session id (aico recent list shows them)`)
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
    io.err(
      `aico recent: unknown command '${sub}' (list, show or events); aico recent --help shows how`,
    )
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
    io.err(
      code === 'unknown_session' && id
        ? `No session ${id} (aico recent list shows the recent ones).`
        : (REFUSALS[code] ?? `Tether refused: ${code}`),
    )
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
    for (const row of table(items)) io.out(row)
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
  if (page.items.length) io.out('Longer text is cut; --json gives the whole records.')
  if (page.older !== null) io.out(`older: --before ${page.older}`)
  if (page.newer !== null) io.out(`newer: --from ${page.newer}`)
  return 0
}

const VALUE_FLAGS = new Set(['--tool', '--project', '--limit', '--before', '--from'])
function isFlagValue(args: string[], index: number): boolean {
  return index > 0 && VALUE_FLAGS.has(args[index - 1] ?? '')
}

const REFUSALS: Record<string, string> = {
  unknown_session: 'No session with that id. aico recent list shows the recent ones.',
  ambiguous_session: 'More than one session starts with that. Use more of the id.',
  transcript_gone:
    "The tool's transcript file is gone, so its events cannot be read. The totals are still kept.",
  not_found: 'This Tether is too old for session history (needs API 27). Update it.',
}
