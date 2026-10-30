// Owner asks for the web app's Needs you drawer: the default Tether keeps them
// (GET /v1/asks) and announces each change (`asks.changed`); the server lists
// them for the drawer, passes the owner's answer back, and pushes one fixed-text
// Nightshift notice for each new blocking ask. The Approvals tab lists
// Nightshift's pending taps (`nightshift pending --json`) as links only:
// approving stays in Nightshift. Every field crosses an agent-controlled
// boundary, so each is checked again here.

import type { TetherClient } from 'tether/client'
import { objectBody, type Router } from './http'
import { tetherCall } from './lifecycle'
import { type Notice, type RunCommand, resolveNotice, runCommand, sendNotice } from './notice'
import { HttpError } from './tether'

const PENDING_TIMEOUT_MS = 8_000
/** Ids pushed already, so a replayed event never pushes twice. */
const PUSHED_KEPT = 500

const ID = /^[0-9a-f]{12}$/
const SESSION = /^[0-9a-f]{8}$/
const NOT_ONE_LINE = /[\p{Cc}\p{Cf}\p{Cs}\p{Zl}\p{Zp}]/u
// biome-ignore lint/suspicious/noControlCharactersInRegex: rejecting control characters is the point
const NOT_TEXT = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f\p{Cf}\p{Cs}\p{Zl}\p{Zp}]/u
const STATES = ['open', 'answered', 'done', 'withdrawn'] as const

export interface Ask {
  id: string
  session: string | null
  requester: string | null
  question: string
  options: string[]
  recommended: number | null
  body: string | null
  command: string | null
  share: string | null
  blocking: boolean
  state: (typeof STATES)[number]
  answer: string | null
  note: string | null
  delivery: 'wake' | 'pull' | null
  createdAt: number
  updatedAt: number
  answeredAt: number | null
}

const length = (text: string) => Array.from(text).length
const line = (value: unknown, max: number): value is string =>
  typeof value === 'string' &&
  length(value) >= 1 &&
  length(value) <= max &&
  !NOT_ONE_LINE.test(value)
const text = (value: unknown, max: number): value is string | null =>
  value === null || (typeof value === 'string' && length(value) <= max && !NOT_TEXT.test(value))
const time = (value: unknown): value is number =>
  Number.isSafeInteger(value) && (value as number) >= 0

/** An ask as Tether sends it, or null when any field is not what Tether sends. */
export function validateAsk(data: unknown): Ask | null {
  if (!data || typeof data !== 'object' || Array.isArray(data)) return null
  const a = data as Record<string, unknown>
  if (typeof a.id !== 'string' || !ID.test(a.id)) return null
  if (a.session !== null && (typeof a.session !== 'string' || !SESSION.test(a.session))) return null
  if (a.requester !== null && !line(a.requester, 60)) return null
  if (a.session === null && a.requester === null) return null
  if (!line(a.question, 200)) return null
  if (!Array.isArray(a.options) || a.options.length > 5 || !a.options.every((o) => line(o, 100)))
    return null
  if (
    a.recommended !== null &&
    (!Number.isSafeInteger(a.recommended) ||
      (a.recommended as number) < 0 ||
      (a.recommended as number) >= a.options.length)
  )
    return null
  if (!text(a.body, 4000) || !text(a.command, 2000) || !text(a.note, 1000)) return null
  if (a.share !== null && (typeof a.share !== 'string' || !ID.test(a.share))) return null
  if (a.answer !== null && !line(a.answer, 100)) return null
  if (typeof a.blocking !== 'boolean') return null
  if (!STATES.includes(a.state as Ask['state'])) return null
  if (a.delivery !== null && a.delivery !== 'wake' && a.delivery !== 'pull') return null
  if (!time(a.createdAt) || !time(a.updatedAt) || (a.answeredAt !== null && !time(a.answeredAt)))
    return null
  return {
    id: a.id,
    session: a.session as string | null,
    requester: a.requester as string | null,
    question: a.question,
    options: a.options as string[],
    recommended: a.recommended as number | null,
    body: a.body,
    command: a.command,
    share: a.share as string | null,
    blocking: a.blocking,
    state: a.state as Ask['state'],
    answer: a.answer as string | null,
    note: a.note,
    delivery: a.delivery as Ask['delivery'],
    createdAt: a.createdAt as number,
    updatedAt: a.updatedAt as number,
    answeredAt: a.answeredAt as number | null,
  }
}

export type { RunCommand }

/** The Nightshift notice for a new blocking ask: the session's name, never the question. A question needs the
 * ask's own link; without the public host it goes as plain information. */
export function askNotice(ask: Ask, who: string | null, publicHost: string | null): Notice {
  const notice: Notice = {
    v: 1,
    source: 'aico',
    kind: publicHost ? 'question' : 'info',
    severity: 'warning',
    title: 'An agent is waiting on you',
    body: `${who ? `“${who}”` : 'A session'} has a question for you. Open Aico to answer it.`,
    key: askKey(ask.id),
    push: 'phone',
  }
  if (publicHost) {
    notice.open = `https://${publicHost}/?ask=${ask.id}`
    notice.actions = ['answer']
    notice.primary = 'answer'
  }
  return notice
}

export const askKey = (id: string) => `ask:${id}`

/** A Nightshift tap waiting for the owner, as a link. */
export interface Approval {
  id: string
  title: string
  url: string
  expiresInS: number
}

export function parsePending(stdout: string): Approval[] | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(stdout)
  } catch {
    return null
  }
  const taps = (parsed as { taps?: unknown } | null)?.taps
  if (!Array.isArray(taps)) return null
  return taps.flatMap((tap) => {
    const t = tap as Record<string, unknown>
    if (!line(t.id, 100) || !line(t.title, 200) || typeof t.url !== 'string') return []
    let url: URL
    try {
      url = new URL(t.url)
    } catch {
      return []
    }
    if (url.protocol !== 'https:') return []
    const left = Number(t.expires_in_s)
    return [
      {
        id: t.id,
        title: t.title,
        url: url.href,
        expiresInS: Number.isFinite(left) ? Math.max(0, Math.round(left)) : 0,
      },
    ]
  })
}

/** What Asks needs of Tether. */
type AskSource = Pick<TetherClient, 'request'> & Partial<Pick<TetherClient, 'getSession'>>

export class Asks {
  private readonly pushed = new Set<string>()

  constructor(
    private readonly options: {
      tether: AskSource
      publicHost: string | null
      run?: RunCommand
    },
  ) {}

  private get run(): RunCommand {
    return this.options.run ?? runCommand
  }

  /** An `asks.changed` event's data from the trusted Tether: push a new blocking ask once. */
  async receive(data: unknown): Promise<void> {
    const record = data && typeof data === 'object' ? (data as Record<string, unknown>) : {}
    const ask = validateAsk(record.ask)
    if (record.created !== true) {
      // A blocking ask that is no longer open stops being a waiting notice.
      if (ask?.blocking && ask.state !== 'open')
        await resolveNotice(this.run, askKey(ask.id), `The ask was ${ask.state}.`)
      return
    }
    if (!ask) {
      console.log('[aico-web] ask rejected')
      return
    }
    if (!ask.blocking || ask.state !== 'open' || this.pushed.has(ask.id)) return
    this.pushed.add(ask.id)
    if (this.pushed.size > PUSHED_KEPT) this.pushed.delete(this.pushed.values().next().value ?? '')
    let who: string | null = null
    if (ask.session && this.options.tether.getSession) {
      try {
        const session = await this.options.tether.getSession(ask.session)
        const name = session.displayTitle?.trim() || session.label
        who = line(name, 120) ? name : null
      } catch {
        // The push still goes out, naming no session.
      }
    } else who = ask.requester
    await sendNotice(this.run, askNotice(ask, who, this.options.publicHost))
  }

  /** Open and answered asks plus recently closed ones; any failing the checks are left out. */
  async list(): Promise<Ask[]> {
    const { body } = await tetherCall(() =>
      this.options.tether.request<{ items?: unknown }>('GET', '/v1/asks'),
    )
    if (!Array.isArray(body?.items)) return []
    return body.items.map(validateAsk).filter((ask): ask is Ask => ask !== null)
  }

  async act(id: string, action: 'answer' | 'done', body?: Record<string, unknown>): Promise<Ask> {
    if (!ID.test(id)) throw new HttpError(404, 'That question is gone')
    const { body: result } = await tetherCall(
      () => this.options.tether.request<unknown>('POST', `/v1/asks/${id}/${action}`, body),
      'That question is gone',
    )
    const ask = validateAsk(result)
    if (!ask) throw new HttpError(502, 'Tether answered with an ask that does not check out')
    return ask
  }

  /** Nightshift's pending taps, or null when it cannot be read. */
  async approvals(): Promise<Approval[] | null> {
    try {
      return parsePending(await this.run(['nightshift', 'pending', '--json'], PENDING_TIMEOUT_MS))
    } catch {
      return null
    }
  }
}

export function registerAskRoutes(router: Router, asks: Asks): void {
  router.on('GET', '/api/asks', async () => ({ asks: await asks.list() }))

  router.on('POST', '/api/asks/:askId/answer', async (ctx) => {
    const body = objectBody(await ctx.body())
    const answer: Record<string, unknown> = {}
    if (body.option !== undefined) {
      if (!Number.isSafeInteger(body.option)) throw new HttpError(400, 'Pick one of the choices')
      answer.option = body.option
    }
    for (const key of ['text', 'note'] as const) {
      const value = body[key]
      if (value === undefined || value === null || value === '') continue
      if (typeof value !== 'string') throw new HttpError(400, `Invalid ${key}`)
      answer[key] = value
    }
    if (!Object.keys(answer).length) throw new HttpError(400, 'Pick a choice or write a note')
    return { ask: await asks.act(ctx.params.askId, 'answer', answer) }
  })

  router.on('POST', '/api/asks/:askId/done', async (ctx) => ({
    ask: await asks.act(ctx.params.askId, 'done'),
  }))

  // Links only: approving happens in Nightshift with the security key.
  router.on('GET', '/api/approvals', async () => {
    const taps = await asks.approvals()
    return taps === null ? { state: 'unavailable', taps: [] } : { state: 'ok', taps }
  })
}
