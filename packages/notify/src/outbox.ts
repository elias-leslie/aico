// The one deliverer: every phone push leaves through here. A pass claims the
// due rows (each becomes `sending` in one write), sends each once, and records
// the outcome: sent, failed for good, or pending again after a backoff. A send
// that may have reached FCM (a stopped process, a timeout or reset after the
// request went out) turns `unsure` and is never resent, so a notice reaches a
// phone at most once. While the paired-phones file can't be read, rows wait
// (pending) and are tried again. Its Status row says what it did.

import type { StatusRow } from '@aico/status'
import { keptOffPhone, NO_CHOICES, type NoticeChoices, phoneSilenced } from './choices'
import { itemPlaintext, type PhoneSender, type SendResult, TTL_S } from './fcm'
import { ANY_PHONE, type NotifyStore } from './store'

/** First retry after this; each later one waits twice as long, up to MAX_BACKOFF_MS. */
export const FIRST_BACKOFF_MS = 15_000
const MAX_BACKOFF_MS = 15 * 60_000
/** A notice still not delivered this long after it arrived is given up. */
export const GIVE_UP_MS = 24 * 3600_000
/** Waiting longer than this makes the Status row a problem. */
const STUCK_MS = 10 * 60_000
const DAY_MS = 24 * 3600_000

export function backoff(attempts: number): number {
  return Math.min(FIRST_BACKOFF_MS * 2 ** Math.max(0, attempts), MAX_BACKOFF_MS)
}

const RETRY: ReadonlySet<SendResult> = new Set(['retry', 'no-token'])
const PHONES_UNREADABLE = "can't read the paired phones"

export interface OutboxOptions {
  store: NotifyStore
  sender: PhoneSender
  /** The Aico host a tap opens when the notice has no link of its own. */
  publicHost: string | null
  /** The owner's Settings choices: a push still queued when its type goes off is dropped. */
  choices?: NoticeChoices
  now?: () => number
}

export class Outbox {
  private running: Promise<number> | null = null
  private again = false
  /** Status rows in a row that found the paired-phones file unreadable. */
  private unreadable = 0
  private readonly now: () => number

  constructor(private readonly options: OutboxOptions) {
    this.now = options.now ?? Date.now
  }

  /** Call once before the first pass: rows a stopped process left mid-send are never resent. */
  recover(): number {
    return this.options.store.markUnsure(this.now())
  }

  /** Runs a pass now, or right after the one running; resolves with the rows it sent. */
  kick(): Promise<number> {
    if (this.running) {
      this.again = true
      return this.running
    }
    this.running = (async () => {
      let sent = 0
      try {
        do {
          this.again = false
          sent += await this.pass()
        } while (this.again)
      } finally {
        this.running = null
      }
      return sent
    })()
    return this.running
  }

  /** One pass over the due rows; the number sent. */
  async pass(): Promise<number> {
    const { store, sender } = this.options
    const rows = store.claimDue(this.now())
    if (rows.length === 0) return 0
    const paired = sender.devices()
    const devices = new Map((paired ?? []).map((device) => [device.id, device]))
    let sent = 0
    for (const row of rows) {
      const stored = store.get(row.noticeId)
      const device = devices.get(row.device)
      const now = this.now()
      if (stored && paired === null) {
        // Not the phone's fault and not for good: wait and read the file again.
        const result = PHONES_UNREADABLE
        if (now - row.receivedAt < GIVE_UP_MS)
          store.finish(row.id, { retryAt: now + backoff(row.attempts), result }, now)
        else store.finish(row.id, { state: 'failed', result }, now)
        continue
      }
      if (stored && row.device === ANY_PHONE) {
        store.expand(row.id, [...devices.keys()], now)
        this.again = true
        continue
      }
      if (!stored) {
        store.finish(row.id, { state: 'failed', result: 'notice missing' }, now)
        continue
      }
      const { notice } = stored
      if (phoneSilenced(notice, this.options.choices ?? NO_CHOICES)) {
        store.dropOutboxRow(row.id)
        store.rewriteNotice(stored.id, keptOffPhone(notice))
        continue
      }
      if (notice.expires && now > stored.receivedAt + notice.expires * 1000) {
        store.finish(row.id, { state: 'failed', result: 'ended before it could be sent' }, now)
        continue
      }
      if (!device) {
        store.finish(row.id, { state: 'failed', result: 'phone no longer paired' }, now)
        continue
      }
      let result: SendResult
      try {
        result = await sender.send(
          device,
          itemPlaintext(stored.id, notice, now, this.options.publicHost),
          TTL_S[notice.severity],
        )
      } catch (error) {
        result = 'retry'
        console.error(`[notify] send ${stored.id} failed:`, (error as Error).message)
      }
      const at = this.now()
      if (result === 'sent') {
        sent += 1
        store.finish(row.id, { state: 'sent', result }, at)
      } else if (result === 'unsure') store.finish(row.id, { state: 'unsure', result }, at)
      else if (RETRY.has(result) && at - row.receivedAt < GIVE_UP_MS)
        store.finish(row.id, { retryAt: at + backoff(row.attempts), result }, at)
      else store.finish(row.id, { state: 'failed', result }, at)
      console.log(`[notify] ${stored.id} to ${row.device}: ${result}`)
    }
    return sent
  }

  /** The outbox's Status row; due again after two passes (`passMs` apart). */
  statusRow(machine: string, passMs: number): StatusRow {
    const now = this.now()
    const s = this.options.store.outboxSummary(now - DAY_MS)
    const devices = this.options.sender.devices()
    this.unreadable = devices === null ? this.unreadable + 1 : 0
    // One failed read can be a file mid-rewrite; still unreadable a pass later is a problem.
    const unreadable = this.unreadable >= 2
    const stuck =
      devices !== null && s.oldestPendingAt !== null && now - s.oldestPendingAt > STUCK_MS
    const problem = s.failed > 0 || s.unsure > 0 || stuck
    const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`
    const parts: string[] = []
    if (unreadable) parts.push("Can't read the paired phones, so alerts wait until it can.")
    else if (devices?.length === 0) parts.push('No phone is paired, so nothing reaches a phone.')
    parts.push(`Sent ${plural(s.sent, 'alert')} to the phone in the last day.`)
    if (s.pending)
      parts.push(`${plural(s.pending, 'alert')} waiting${stuck ? ' over 10 min' : ''}.`)
    if (s.failed) parts.push(`${plural(s.failed, 'alert')} not delivered.`)
    if (s.unsure) parts.push(`${plural(s.unsure, 'alert')} may not have gone out.`)
    if (problem && s.lastProblem) parts.push(`Last: ${s.lastProblem}.`)
    return {
      id: `${machine}/notify-outbox`,
      what: 'Phone alerts',
      kind: 'service',
      machine,
      project: 'aico',
      state: problem ? 'failed' : unreadable || devices?.length === 0 ? 'warn' : 'ok',
      meaning: parts.join(' ').slice(0, 300),
      last_run: new Date(now).toISOString(),
      next_run: new Date(now + 2 * passMs).toISOString(),
      actions: [
        { kind: 'log', ref: 'journalctl --user -u aico-web.service -g notify -n 200 --no-pager' },
      ],
    }
  }
}
