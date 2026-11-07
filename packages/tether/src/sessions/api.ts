// `GET /v1/history` (API 27): the session history (history.ts). The list, one
// session's totals, and its events read from the tool's transcript.
// `PUT /v1/history/aico-agent/:run`: the Aico agent pushes a run's totals and
// turns at its start and end (it keeps no transcript Tether reads).

import { HttpError, type Router, readJsonObject, sendJson } from '../http'
import type { History, PushedRun, RunTurn } from './history'
import type { Outcome } from './types'

function count(value: string | null, field: string): number | undefined {
  if (value === null) return undefined
  if (!/^\d{1,9}$/.test(value)) throw new HttpError(400, 'invalid_query', { field })
  return Number(value)
}

const RUN_ID = /^[A-Za-z0-9-]{8,64}$/
const OUTCOMES: readonly (Outcome | null)[] = ['completed', 'aborted', 'error', null]
const MAX_TURNS = 1000

/** Validate a pushed run (`PUT /v1/history/aico-agent/:run`). */
function parsePushedRun(runId: string, body: Record<string, unknown>): PushedRun {
  const bad = (field: string): never => {
    throw new HttpError(400, 'invalid_body', { field })
  }
  if (!RUN_ID.test(runId)) bad('run')
  const known = [
    'cwd',
    'role',
    'startedAt',
    'endedAt',
    'outcome',
    'tokens',
    'toolCalls',
    'turns',
    'chat',
  ]
  const extra = Object.keys(body).filter((key) => !known.includes(key))
  if (extra.length) throw new HttpError(400, 'invalid_body', { fields: extra })
  const n = (value: unknown, field: string): number =>
    Number.isSafeInteger(value) && (value as number) >= 0 ? (value as number) : bad(field)
  const text = (value: unknown, field: string, max: number): string =>
    typeof value === 'string' && value.length > 0 && value.length <= max ? value : bad(field)
  const { cwd, role, startedAt, endedAt, outcome, tokens, toolCalls, turns } = body
  if (typeof cwd !== 'string' || !cwd.startsWith('/') || cwd.length > 4096) bad('cwd')
  if (!OUTCOMES.includes(outcome as Outcome | null)) bad('outcome')
  if (!tokens || typeof tokens !== 'object') bad('tokens')
  const t = tokens as Record<string, unknown>
  if (!Array.isArray(turns) || turns.length > MAX_TURNS) bad('turns')
  let chat: PushedRun['chat']
  if (body.chat !== undefined) {
    if (!body.chat || typeof body.chat !== 'object' || Array.isArray(body.chat)) bad('chat')
    const c = body.chat as Record<string, unknown>
    if (
      !['working', 'idle', 'stopped', 'failed', 'ended', 'swapped', 'needs-you'].includes(
        String(c.state),
      )
    )
      bad('chat.state')
    chat = {
      title: text(c.title, 'chat.title', 200),
      state: String(c.state),
      updatedAt: n(c.updatedAt, 'chat.updatedAt'),
    }
  }
  return {
    ...(chat && { chat }),
    runId,
    cwd: cwd as string,
    role: role === null || role === undefined ? null : text(role, 'role', 100),
    startedAt: n(startedAt, 'startedAt'),
    endedAt: endedAt === null ? null : n(endedAt, 'endedAt'),
    outcome: outcome as Outcome | null,
    tokens: {
      input: n(t.input, 'tokens'),
      cacheRead: n(t.cacheRead, 'tokens'),
      cacheWrite: n(t.cacheWrite, 'tokens'),
      output: n(t.output, 'tokens'),
    },
    toolCalls: n(toolCalls, 'toolCalls'),
    turns: (turns as unknown[]).map((item): RunTurn => {
      const turn = (item ?? {}) as Record<string, unknown>
      return {
        turn: n(turn.turn, 'turns'),
        model: text(turn.model, 'turns', 200),
        stop: text(turn.stop, 'turns', 40),
      }
    }),
  }
}

export function registerHistoryRoutes(router: Router, history: History): void {
  const find = (id: string | undefined) => {
    const row = history.find(id ?? '')
    if (row === 'ambiguous') throw new HttpError(409, 'ambiguous_session')
    if (!row) throw new HttpError(404, 'unknown_session')
    return row
  }
  router
    .add('PUT', '/v1/history/owner', async (req, res) => {
      const body = await readJsonObject(req)
      if (
        typeof body.session !== 'string' ||
        !/^[0-9a-f]{8}$/.test(body.session) ||
        typeof body.nativeId !== 'string' ||
        !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(body.nativeId) ||
        !['codex', 'claude-code', 'pi'].includes(String(body.tool))
      )
        throw new HttpError(400, 'invalid_body')
      history.bind(body.session, String(body.tool), body.nativeId)
      sendJson(res, 200, { kept: true })
    })
    .add('GET', '/v1/history', (_req, res, _params, query) => {
      const items = history.list({
        limit: count(query.get('limit'), 'limit'),
        tool: query.get('tool') ?? undefined,
        project: query.get('project') ?? undefined,
        session: query.get('session') ?? undefined,
      })
      sendJson(res, 200, { items })
    })
    .add('PUT', '/v1/history/aico-agent/:run', async (req, res, params) => {
      const run = parsePushedRun(params.run ?? '', await readJsonObject(req))
      sendJson(res, 200, { kept: history.record(run) })
    })
    .add('GET', '/v1/history/search', async (_req, res, _params, query) => {
      // A client that goes away (a newer search replaced this one) ends the read.
      const gone = new AbortController()
      res.once('close', () => gone.abort())
      const text = (query.get('q') ?? '').trim()
      if (text.length < 2 || text.length > 200)
        throw new HttpError(400, 'invalid_query', { field: 'q' })
      sendJson(
        res,
        200,
        await history.search(text, {
          limit: count(query.get('limit'), 'limit'),
          tool: query.get('tool') ?? undefined,
          project: query.get('project') ?? undefined,
          hits: count(query.get('hits'), 'hits'),
          signal: gone.signal,
        }),
      )
    })
    .add('GET', '/v1/history/:id', (_req, res, params) => {
      sendJson(res, 200, history.get(find(params.id)))
    })
    .add('GET', '/v1/history/:id/events', (_req, res, params, query) => {
      const row = find(params.id)
      const page = history.events(row, {
        limit: count(query.get('limit'), 'limit'),
        before: count(query.get('before'), 'before'),
        from: count(query.get('from'), 'from'),
      })
      if (page === 'gone') throw new HttpError(410, 'transcript_gone')
      sendJson(res, 200, page)
    })
}
