// Needs you: what asks the owner something shows there as a Tether ask, the
// one ask store. A failed Status row with an owner-only action raises an ask, withdrawn when
// the row recovers; a notice that asks something (a todo, an alert offering
// "That was me", a question not already an ask) raises one too. The owner's
// "That was me" on an OmniNull alert goes back to the hub's verdict route.

import type { StatusRow } from '@aico/status'
import { asksOwner, asksVerdict, type Notice } from './notice'
import type { NotifyStore } from './store'

/** An ask as Tether's API takes it (POST /v1/asks). */
export interface AskRequest {
  requester: string
  question: string
  options: string[]
  body: string | null
  command: string | null
  /** The https link the card opens: the notice's own item. */
  open: string | null
}

/** What Needs you needs of Tether's asks. */
export interface AskPort {
  /** Files the ask (or updates the same open question); its id. */
  create(ask: AskRequest): Promise<string>
  /** Closes it: done once acted on, withdraw when it no longer applies. Closed already is fine. */
  close(id: string, how: 'done' | 'withdraw'): Promise<void>
}

/** The OmniNull hub's verdict route: confirms the alerts benign; says what happened. */
export interface VerdictPort {
  confirmBenign(alertIds: string[]): Promise<string>
}

export const THAT_WAS_ME = 'That was me'
export const NOT_ME = 'Not me'
export const DONE = 'Done'
const ROW_REQUESTER = 'Aico Status'
/** The hub's verdict route takes at most this many alerts. */
const MAX_VERDICT_IDS = 10

/** The hub's alert ids an OmniNull notice names in its key (`alerts:<id>[,<id>...]`). */
export function alertIds(notice: Notice): string[] {
  const match = /^alerts:(.+)$/.exec(notice.key ?? '')
  if (notice.source !== 'ominull' || !match) return []
  return [...new Set((match[1] as string).split(',').filter(Boolean))].slice(0, MAX_VERDICT_IDS)
}

const cut = (text: string, max: number) =>
  [...text].length <= max ? text : `${[...text].slice(0, max - 1).join('')}…`
const oneLine = (text: string) => text.replace(/\s+/g, ' ').trim()

/**
 * A notice's ask. The question ends with the notice's short id: Tether merges an open ask with
 * the same requester and question into one, and each notice needs its own ask, so that "That was
 * me" confirms that notice's alerts and no other's. The id is for Tether only; the Aico card
 * hides it (`askTitle`), and `open` is the item the card's Open button goes to.
 */
function noticeAsk(id: string, notice: Notice): AskRequest {
  const body = [
    notice.body,
    notice.detail ?? '',
    ...notice.fields.map((field) => `${field.label}: ${field.value}`),
    notice.if_ignored ? `If you leave it: ${notice.if_ignored}` : '',
  ]
    .filter(Boolean)
    .join('\n\n')
  const verdict = asksVerdict(notice)
  return {
    requester: notice.source,
    question: `${cut(oneLine(verdict ? `Was this you? ${notice.title}` : notice.title), 190)} (#${id.slice(0, 6)})`,
    options: verdict ? [THAT_WAS_ME, NOT_ME] : notice.kind === 'todo' ? [DONE] : [],
    body: cut(body, 4000),
    command: notice.command ?? null,
    open: notice.open ?? null,
  }
}

export function rowAsk(row: StatusRow): AskRequest {
  const run = row.actions?.find((action) => action.owner_only === true && action.kind === 'run')
  return {
    requester: ROW_REQUESTER,
    question: cut(oneLine(`${row.what} failed on ${row.machine}`), 200),
    options: [],
    body: row.meaning,
    command: run?.ref ?? null,
    open: null,
  }
}

export interface AnsweredAsk {
  id: string
  state: string
  answer: string | null
}

export class NeedsYou {
  constructor(
    private readonly options: {
      store: NotifyStore
      asks: AskPort
      verdict?: VerdictPort | null
      now?: () => number
    },
  ) {}

  private get now(): number {
    return (this.options.now ?? Date.now)()
  }

  /** A notice just accepted: files its ask when it asks the owner something. */
  async noticeAccepted(id: string, notice: Notice): Promise<void> {
    if (!asksOwner(notice)) return
    const askId = await this.options.asks.create(noticeAsk(id, notice))
    this.options.store.setAsk(id, askId)
  }

  /** The sender resolved this notice; its owner question no longer applies. */
  async noticeResolved(id: string): Promise<void> {
    const stored = this.options.store.get(id)
    if (stored?.askId) await this.options.asks.close(stored.askId, 'withdraw')
  }

  /** Only a failed row with an owner-only action raises an ask; other rows withdraw old asks. */
  async rowsWritten(rows: readonly StatusRow[]): Promise<void> {
    const { store, asks } = this.options
    for (const row of rows) {
      const raised = store.rowAsk(row.id)
      const ownerAction = row.actions?.some((action) => action.owner_only === true) ?? false
      if (row.state === 'failed' && ownerAction && !raised) {
        store.setRowAsk(row.id, await asks.create(rowAsk(row)), this.now)
      } else if ((row.state !== 'failed' || !ownerAction) && raised) {
        await asks.close(raised, 'withdraw')
        store.dropRowAsk(row.id)
      }
    }
  }

  /** A row dropped: its ask, if any, no longer applies. */
  async rowRemoved(id: string): Promise<void> {
    const raised = this.options.store.rowAsk(id)
    if (!raised) return
    this.options.store.dropRowAsk(id)
    await this.options.asks.close(raised, 'withdraw')
  }

  /**
   * An ask changed in Tether. The owner's answer to a notice's ask is recorded once; "That was
   * me" on an OmniNull alert is sent to the hub; the ask is then closed as done.
   */
  async askChanged(ask: AnsweredAsk): Promise<void> {
    if (ask.state !== 'answered' || ask.answer === null) return
    const { store } = this.options
    const stored = store.byAsk(ask.id)
    if (!stored || !store.answer(stored.id, ask.answer, this.now)) return
    let outcome = `Answered: ${ask.answer}`
    if (asksVerdict(stored.notice)) {
      const ids = alertIds(stored.notice)
      if (ask.answer !== THAT_WAS_ME) outcome = 'Not you: left open on OmniNull.'
      else if (ids.length === 0 || !this.options.verdict)
        outcome = 'That was you; nothing to send to OmniNull.'
      else outcome = await this.options.verdict.confirmBenign(ids)
    }
    store.setOutcome(stored.id, outcome)
    await this.options.asks.close(ask.id, 'done')
  }
}
