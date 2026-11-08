// One door for notices: checks a notice against the contract, logs it, queues
// it for the paired phones when it asks for the phone, wakes the outbox, and
// files its Needs-you ask when it asks the owner something.

import {
  applyDailyLimit,
  applyPhoneChoice,
  desktopCard,
  headedToPhone,
  NO_CHOICES,
  type NoticeChoices,
} from './choices'
import type { PhoneSender } from './fcm'
import type { NeedsYou } from './needs-you'
import { type Notice, parseNotice } from './notice'
import type { Outbox } from './outbox'
import { type Accepted, ANY_PHONE, type NotifyStore, type Via } from './store'
import { typeOf } from './types'

export interface NotifierOptions {
  store: NotifyStore
  sender: PhoneSender
  outbox: Outbox
  needsYou: NeedsYou
  /** The owner's Settings choices; read on every notice. */
  choices?: NoticeChoices
  /** This Aico's name on what it raises (AICO_HOST_NAME). */
  raisedBy?: string
  /** The machine a notice is about when nothing names one: this one. */
  machine?: string
  now?: () => number
  log?: (line: string) => void
}

/** A machine named in a sender's fields (the hub's Host), else this one; the project, else the source. */
function aboutOf(
  notice: Notice,
  machine: string | undefined,
): { machine?: string; project: string } {
  const named = notice.fields.find((field) => /^(host|machine)$/i.test(field.label))?.value
  const about = notice.machine ?? named?.trim() ?? machine
  return { ...(about ? { machine: about } : {}), project: notice.project ?? notice.source }
}

/**
 * An OmniNull detection page (an alert keyed `alerts:<id>`, warning or critical) is a security
 * event whatever the hub's own routing says; the hub is not ours to change, so the reason is
 * added here, once, at the door.
 */
function hubPage(value: unknown, via: Via): unknown {
  const body = value as Record<string, unknown> | null
  if (via !== 'ominull' || !body || typeof body !== 'object' || body.interrupt !== undefined)
    return value
  const page =
    (body.kind === undefined || body.kind === 'alert') &&
    (body.severity === 'warning' || body.severity === 'critical') &&
    typeof body.key === 'string' &&
    body.key.startsWith('alerts:')
  return page ? { ...body, interrupt: 'security' } : value
}

export class Notifier {
  private readonly pendingAsks = new Map<string, Promise<void>>()

  constructor(private readonly options: NotifierOptions) {}

  /** Takes a notice (NoticeError when it breaks the contract); the outbox and the ask follow on their own. */
  receive(value: unknown, via: Via): Accepted {
    const { store, sender, outbox, needsYou } = this.options
    const log = this.options.log ?? ((line: string) => console.log(`[notify] ${line}`))
    const now = (this.options.now ?? Date.now)()
    const parsed = parseNotice(hubPage(value, via))
    const choices = this.options.choices ?? NO_CHOICES
    const notice = {
      ...applyDailyLimit(applyPhoneChoice(parsed, choices), () =>
        this.pushedToday(typeOf(parsed), now),
      ),
      desktop_card: desktopCard(parsed, choices),
      ...aboutOf(parsed, this.options.machine),
      ...(this.options.raisedBy ? { raised_by: this.options.raisedBy } : {}),
    }
    // When the paired-phones file can't be read, one row waits for any phone; the outbox
    // turns it into a row per phone once the file reads again.
    const devices =
      notice.push === 'phone' ? (sender.devices()?.map((device) => device.id) ?? [ANY_PHONE]) : []
    const accepted = store.accept(notice, via, devices, now)
    log(
      `${accepted.repeat ? 'repeat of' : 'took'} ${accepted.id} from ${notice.source} via ${via} (${notice.severity}, ${notice.push}${devices[0] === ANY_PHONE ? ', phones unknown yet' : devices.length ? `, ${devices.length} phone(s)` : ''})`,
    )
    if (accepted.repeat) return accepted
    if (devices.length)
      void outbox.kick().catch((error) => log(`outbox pass failed: ${(error as Error).message}`))
    const pending = needsYou
      .noticeAccepted(accepted.id, notice)
      .catch((error) =>
        log(`could not file the ask for ${accepted.id}: ${(error as Error).message}`),
      )
    this.pendingAsks.set(accepted.id, pending)
    void pending.finally(() => this.pendingAsks.delete(accepted.id))
    return accepted
  }

  /** How many notices of a type went to the phone since this calendar day began. */
  private pushedToday(type: string, now: number): number {
    const midnight = new Date(now).setHours(0, 0, 0, 0)
    return this.options.store
      .since(midnight)
      .filter((stored) => headedToPhone(stored) && typeOf(stored.notice) === type).length
  }

  /** Resolve after pending creation, so an in-flight ask cannot reopen the condition. */
  async resolve(
    source: string,
    key: string,
    text: string,
  ): Promise<Accepted & { resolved: number }> {
    const notices = this.options.store.forKey(source, key)
    for (const stored of notices) {
      await this.pendingAsks.get(stored.id)
      await this.options.needsYou.noticeResolved(stored.id)
    }
    // Nothing open under the key (never sent, or already ended by an ok): there is nothing to end,
    // so no notice is written at all.
    const newest = notices[0]
    if (!newest || newest.notice.severity === 'ok')
      return { id: newest?.id ?? '', repeat: true, resolved: 0 }
    // The ok that follows is what ends the earlier notices for the tray (the same key). It says
    // nothing new, so the tray door never pops it up (popsUp in phone.ts).
    const accepted = this.receive(
      {
        v: 1,
        source,
        key,
        kind: 'info',
        severity: 'ok',
        title: text.slice(0, 200),
        body: text,
        cooldown: 0,
      },
      'local',
    )
    return { ...accepted, resolved: notices.length }
  }
}
